import http from 'node:http';
import { URL } from 'node:url';
import {
  type ApprovalRequest,
  type BrainCommand,
  type BrainCommandAckRequest,
  type BrainEventIngestRequest,
  type BrainPlanTaskRequest,
  type BrainSessionCreateRequest,
  type CommandTargetClient,
  isCommandAck,
  isExecutionEvent,
  isSessionEvent
} from '@google-live-agent/contracts';
import { PostgresMemoryStore } from '@google-live-agent/memory-pg';
import { createLogger } from '@google-live-agent/observability';

const logger = createLogger('brain-api');
const port = Number(process.env.PORT ?? 8080);
const memory = new PostgresMemoryStore(process.env.DATABASE_URL);
const retryIntervalMs = Number(process.env.COMMAND_RETRY_INTERVAL_MS ?? 5_000);
const localAgentToken = process.env.LOCAL_AGENT_TOKEN;

type SseClient = {
  response: http.ServerResponse;
  key: string;
  keepAliveTimer: NodeJS.Timeout;
};

const sseClients = new Map<string, Set<SseClient>>();

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sse(client: SseClient, event: string, data: unknown): void {
  client.response.write(`event: ${event}\n`);
  client.response.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function requireAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!localAgentToken) return true;
  const headerToken = req.headers['x-local-agent-token'];
  if (headerToken !== localAgentToken) {
    json(res, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

function keyFor(sessionId: string, client: CommandTargetClient): string {
  return `${sessionId}:${client}`;
}

function addSseClient(sessionId: string, client: CommandTargetClient, response: http.ServerResponse): SseClient {
  const key = keyFor(sessionId, client);
  const set = sseClients.get(key) ?? new Set<SseClient>();
  const sseClient: SseClient = {
    response,
    key,
    keepAliveTimer: setInterval(() => {
      response.write(': keepalive\n\n');
    }, 15_000)
  };
  set.add(sseClient);
  sseClients.set(key, set);
  return sseClient;
}

function removeSseClient(client: SseClient): void {
  clearInterval(client.keepAliveTimer);
  const set = sseClients.get(client.key);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) {
    sseClients.delete(client.key);
  }
}

function dispatchCommand(command: BrainCommand): boolean {
  const key = keyFor(command.session_id, command.target);
  const clients = sseClients.get(key);
  if (!clients || clients.size === 0) return false;

  for (const client of clients) {
    sse(client, 'command', command);
  }

  logger.info('command_dispatched', {
    command_id: command.command_id,
    session_id: command.session_id,
    target: command.target,
    client_count: clients.size
  });

  return true;
}

async function queueAndDispatch(command: BrainCommand): Promise<void> {
  await memory.enqueueCommand(command);
  if (dispatchCommand(command)) {
    await memory.markCommandDispatched(command.command_id);
  }
}

function buildCommand(input: {
  sessionId: string;
  taskId: string;
  target: CommandTargetClient;
  action: string;
  correlationId: string;
  payload: Record<string, unknown>;
  ttlSeconds?: number;
}): BrainCommand {
  const now = new Date();
  const ttlSeconds = input.ttlSeconds ?? 60;
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  return {
    command_id: crypto.randomUUID(),
    session_id: input.sessionId,
    task_id: input.taskId,
    target: input.target,
    action: input.action,
    payload: input.payload,
    correlation_id: input.correlationId,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString()
  };
}

async function resendRetryableCommands(): Promise<void> {
  await memory.markExpiredCommands();
  const pending = await memory.getRetryableCommands(100);

  for (const command of pending) {
    if (dispatchCommand(command)) {
      await memory.markCommandDispatched(command.command_id);
    }
  }
}

async function replayPendingForSubscriber(sessionId: string, client: CommandTargetClient): Promise<void> {
  const pending = await memory.getPendingCommandsForSubscriber(sessionId, client, 100);
  for (const command of pending) {
    if (dispatchCommand(command)) {
      await memory.markCommandDispatched(command.command_id);
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/v1/health') {
      const db = await memory.ping();
      return json(res, 200, { ok: true, service: 'brain-api', db });
    }

    if (!requireAuth(req, res)) {
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/commands/stream') {
      const sessionId = url.searchParams.get('session_id') ?? '';
      const client = url.searchParams.get('client') as CommandTargetClient | null;

      if (!sessionId || (client !== 'voice' && client !== 'executor' && client !== 'terminal')) {
        return json(res, 400, { error: 'session_id and valid client are required' });
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive'
      });

      const sseClient = addSseClient(sessionId, client, res);
      sse(sseClient, 'connected', { connected: true, session_id: sessionId, client });
      await replayPendingForSubscriber(sessionId, client);

      req.on('close', () => {
        removeSseClient(sseClient);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/sessions') {
      const body = (await readBody(req)) as BrainSessionCreateRequest;
      return json(res, 201, {
        session_id: body.session_id,
        channel: body.channel,
        created_at: new Date().toISOString()
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/tasks/plan') {
      const body = (await readBody(req)) as BrainPlanTaskRequest;
      return json(res, 200, {
        task_id: body.task_id,
        next_action: {
          command: 'executor-local run --dry-run',
          expected_result: 'execution plan generated'
        }
      });
    }

    const approveMatch = req.method === 'POST' ? url.pathname.match(/^\/v1\/tasks\/([^/]+)\/approve$/) : null;
    if (approveMatch) {
      const pathTaskId = approveMatch[1] ?? '';
      const body = (await readBody(req)) as ApprovalRequest;
      const approval: ApprovalRequest = {
        ...body,
        task_id: body.task_id || pathTaskId
      };

      await memory.savePermissionDecision(approval);

      await queueAndDispatch(
        buildCommand({
          sessionId: approval.session_id,
          taskId: approval.task_id,
          target: 'executor',
          action: 'approval_decision',
          correlationId: `approve:${approval.task_id}`,
          payload: {
            approved: approval.approved,
            approved_by: approval.approved_by,
            command: approval.command,
            reason: approval.reason ?? ''
          }
        })
      );

      return json(res, 200, { ok: true, approved: approval.approved });
    }

    if (req.method === 'POST' && url.pathname.match(/^\/v1\/commands\/[^/]+\/ack$/)) {
      const body = (await readBody(req)) as BrainCommandAckRequest | { ack?: unknown };
      const ack = 'ack' in body ? body.ack : undefined;
      if (!isCommandAck(ack)) {
        return json(res, 400, { error: 'invalid ack payload' });
      }
      await memory.ackCommand(ack);
      return json(res, 200, {
        ok: true,
        command_id: ack.command_id,
        status: ack.status
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/events') {
      const body = (await readBody(req)) as BrainEventIngestRequest;
      if (!(isSessionEvent(body.event) || isExecutionEvent(body.event))) {
        return json(res, 400, { error: 'invalid event payload' });
      }

      await memory.saveEvent(body.event);

      if (body.event.type === 'permission_needed') {
        await queueAndDispatch(
          buildCommand({
            sessionId: body.event.session_id,
            taskId: body.event.task_id,
            target: 'terminal',
            action: 'permission_request',
            correlationId: body.event.correlation_id,
            payload: {
              command: body.event.payload.command,
              reason: body.event.payload.reason
            }
          })
        );
      }

      return json(res, 202, { ingested: true, type: body.event.type });
    }

    return json(res, 404, { error: 'not found' });
  } catch (error) {
    logger.error('request_failed', { message: String(error) });
    return json(res, 500, { error: 'internal_error', message: String(error) });
  }
});

const retryTimer = setInterval(() => {
  resendRetryableCommands().catch((error) => {
    logger.error('command_retry_failed', { message: String(error) });
  });
}, retryIntervalMs);

server.listen(port, () => {
  logger.info('brain_api_started', { port, retry_interval_ms: retryIntervalMs });
});

server.on('close', () => {
  clearInterval(retryTimer);
});
