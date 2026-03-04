import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrainCommand, CommandAck, ExecutionEvent, ExecutionEventType } from '@google-live-agent/contracts';
import { isBrainCommand } from '@google-live-agent/contracts';
import { createLogger } from '@google-live-agent/observability';

const logger = createLogger('executor-local');
const execAsync = promisify(exec);

const brainApiUrl = process.env.BRAIN_API_URL;
const localAgentToken = process.env.LOCAL_AGENT_TOKEN;
const autoApprove = process.env.EXECUTOR_AUTO_APPROVE === 'true';
const timeoutMs = Number(process.env.EXECUTOR_TIMEOUT_MS ?? 15_000);
const maxOutputLength = Number(process.env.EXECUTOR_MAX_OUTPUT ?? 4_000);
const workdir = process.env.EXECUTOR_WORKDIR || process.cwd();
const allowlist = new Set((process.env.EXECUTOR_ALLOWLIST ?? 'echo,pwd,ls,cat,npm,node').split(',').map((v) => v.trim()).filter(Boolean));
const denylist = new Set((process.env.EXECUTOR_DENYLIST ?? 'rm,sudo,shutdown,reboot,mkfs,dd').split(',').map((v) => v.trim()).filter(Boolean));

type RunCommandInput = {
  session_id: string;
  task_id: string;
  command: string;
  reason: string;
  correlation_id?: string;
};

type PendingPermission = RunCommandInput & { created_at: string };

class ExecutionEmitter {
  private sequenceBySession = new Map<string, number>();

  next(type: ExecutionEventType, input: RunCommandInput, payload: Record<string, unknown>): ExecutionEvent {
    const current = this.sequenceBySession.get(input.session_id) ?? 0;
    const sequence = current + 1;
    this.sequenceBySession.set(input.session_id, sequence);

    return {
      event_id: crypto.randomUUID(),
      session_id: input.session_id,
      task_id: input.task_id,
      timestamp: new Date().toISOString(),
      source: 'executor-local',
      sequence,
      correlation_id: input.correlation_id ?? `exec:${input.task_id}`,
      type,
      payload
    };
  }
}

const emitter = new ExecutionEmitter();
const pendingPermissions = new Map<string, PendingPermission>();

function truncate(text: string): string {
  if (text.length <= maxOutputLength) return text;
  return `${text.slice(0, maxOutputLength)}...(truncated)`;
}

function commandHead(command: string): string {
  const [head] = command.trim().split(/\s+/);
  return head ?? '';
}

function validateCommandPolicy(command: string): { ok: true } | { ok: false; reason: string } {
  const head = commandHead(command);
  if (!head) return { ok: false, reason: 'empty command' };
  if (denylist.has(head)) return { ok: false, reason: `denied by denylist (${head})` };
  if (!allowlist.has(head)) return { ok: false, reason: `not in allowlist (${head})` };
  return { ok: true };
}

async function postEvent(event: ExecutionEvent): Promise<void> {
  logger.info('execution_event', event);

  if (!brainApiUrl) return;
  await fetch(`${brainApiUrl}/v1/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(localAgentToken ? { 'x-local-agent-token': localAgentToken } : {})
    },
    body: JSON.stringify({ event })
  });
}

async function ackCommand(command: BrainCommand, status: CommandAck['status'], details?: Record<string, unknown>): Promise<void> {
  if (!brainApiUrl) return;

  const ack: CommandAck = {
    command_id: command.command_id,
    session_id: command.session_id,
    task_id: command.task_id,
    status,
    client_timestamp: new Date().toISOString(),
    correlation_id: command.correlation_id,
    details: {
      client: 'executor',
      ...(details ?? {})
    }
  };

  await fetch(`${brainApiUrl}/v1/commands/${command.command_id}/ack`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(localAgentToken ? { 'x-local-agent-token': localAgentToken } : {})
    },
    body: JSON.stringify({ ack })
  });
}

async function executeApprovedCommand(input: RunCommandInput): Promise<void> {
  const policy = validateCommandPolicy(input.command);
  if (!policy.ok) {
    await postEvent(
      emitter.next('execution_failed', input, {
        command: input.command,
        message: policy.reason
      })
    );
    return;
  }

  await postEvent(
    emitter.next('execution_started', input, {
      command: input.command,
      workdir,
      timeout_ms: timeoutMs
    })
  );

  try {
    const { stdout, stderr } = await execAsync(input.command, {
      cwd: workdir,
      timeout: timeoutMs,
      maxBuffer: maxOutputLength * 4
    });

    await postEvent(
      emitter.next('execution_completed', input, {
        command: input.command,
        stdout: truncate(stdout.trim()),
        stderr: truncate(stderr.trim())
      })
    );
  } catch (error) {
    await postEvent(
      emitter.next('execution_failed', input, {
        command: input.command,
        message: String(error)
      })
    );
  }
}

export async function runCommand(input: RunCommandInput): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];

  const permissionEvent = emitter.next('permission_needed', input, {
    command: input.command,
    reason: input.reason,
    mode: autoApprove ? 'auto' : 'manual'
  });
  events.push(permissionEvent);
  await postEvent(permissionEvent);

  if (autoApprove) {
    await executeApprovedCommand(input);
    return events;
  }

  pendingPermissions.set(input.task_id, {
    ...input,
    created_at: new Date().toISOString()
  });
  return events;
}

async function applyApprovalCommand(command: BrainCommand): Promise<void> {
  await ackCommand(command, 'received');

  if (command.action !== 'approval_decision') {
    await ackCommand(command, 'processed', { ignored: true, reason: 'unsupported action' });
    return;
  }

  const taskId = String(command.payload.task_id ?? command.task_id);
  const approved = Boolean(command.payload.approved);
  const pending = pendingPermissions.get(taskId);

  if (!pending) {
    await ackCommand(command, 'failed', { reason: 'no pending permission request' });
    return;
  }

  if (!approved) {
    await postEvent(
      emitter.next('execution_failed', pending, {
        command: pending.command,
        message: 'execution denied by user approval'
      })
    );
    pendingPermissions.delete(taskId);
    await ackCommand(command, 'processed', { approved: false });
    return;
  }

  const expectedCommand = String(command.payload.command ?? pending.command);
  if (expectedCommand !== pending.command) {
    await ackCommand(command, 'failed', {
      reason: 'command mismatch',
      expected: pending.command,
      received: expectedCommand
    });
    return;
  }

  pendingPermissions.delete(taskId);
  await executeApprovedCommand({
    ...pending,
    correlation_id: command.correlation_id
  });
  await ackCommand(command, 'processed', { approved: true });
}

async function subscribeBrainCommands(sessionId: string): Promise<void> {
  if (!brainApiUrl) {
    logger.info('command_stream_skipped', { reason: 'BRAIN_API_URL not set' });
    return;
  }

  const streamUrl = `${brainApiUrl}/v1/commands/stream?session_id=${encodeURIComponent(sessionId)}&client=executor`;
  const response = await fetch(streamUrl, {
    headers: {
      ...(localAgentToken ? { 'x-local-agent-token': localAgentToken } : {})
    }
  });

  if (!response.ok || !response.body) {
    logger.error('command_stream_failed', { status: response.status, status_text: response.statusText });
    return;
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];

  const flush = async (): Promise<void> => {
    if (!dataLines.length) {
      eventName = 'message';
      return;
    }

    const payloadText = dataLines.join('\n');
    dataLines = [];
    if (eventName !== 'command') {
      eventName = 'message';
      return;
    }

    try {
      const parsed = JSON.parse(payloadText) as unknown;
      if (isBrainCommand(parsed)) {
        await applyApprovalCommand(parsed);
      }
    } catch (error) {
      logger.error('command_parse_failed', { message: String(error) });
    } finally {
      eventName = 'message';
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');

    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);

      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      } else if (line === '') {
        await flush();
      }

      newlineIndex = buffer.indexOf('\n');
    }
  }
}

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

if (process.argv.includes('--self-test')) {
  runCommand({
    session_id: 'local-session',
    task_id: 'T04D',
    command: 'echo executor-local-ok',
    reason: 'self test',
    correlation_id: crypto.randomUUID()
  })
    .then((events) => {
      console.log(JSON.stringify(events, null, 2));
    })
    .catch((error) => {
      logger.error('self_test_failed', { message: String(error) });
      process.exit(1);
    });
} else if (process.argv.includes('--listen')) {
  const sessionId = parseArg('session') ?? process.env.SESSION_ID ?? 'local-session';
  subscribeBrainCommands(sessionId).catch((error) => {
    logger.error('listen_failed', { message: String(error) });
    process.exit(1);
  });
} else {
  console.log('executor-local ready. use --self-test or --listen --session=<id>.');
}
