import { GoogleGenAI } from '@google/genai';
import type { BrainCommand, CommandAck, SessionEvent, SessionEventType } from '@google-live-agent/contracts';
import { isBrainCommand } from '@google-live-agent/contracts';
import { createLogger } from '@google-live-agent/observability';

const logger = createLogger('voice-gateway');
const brainApiUrl = process.env.BRAIN_API_URL;
const localAgentToken = process.env.LOCAL_AGENT_TOKEN;

type ErrorCategory = 'auth' | 'network' | 'model' | 'unknown';
type LiveMode = 'text' | 'mic';

class SessionEventEmitter {
  private sequence = 0;

  constructor(
    private readonly sessionId: string,
    private readonly taskId: string,
    private readonly baseCorrelationId: string
  ) {}

  next(type: SessionEventType, payload: Record<string, unknown>): SessionEvent {
    this.sequence += 1;
    return {
      event_id: crypto.randomUUID(),
      session_id: this.sessionId,
      task_id: this.taskId,
      timestamp: new Date().toISOString(),
      source: 'voice-gateway',
      sequence: this.sequence,
      correlation_id: this.baseCorrelationId,
      type,
      payload
    };
  }
}

function classifyError(error: unknown): ErrorCategory {
  const message = String(error);
  if (/api key|auth|credential|permission/i.test(message)) return 'auth';
  if (/network|timeout|econn|fetch failed/i.test(message)) return 'network';
  if (/model|unsupported|invalid model/i.test(message)) return 'model';
  return 'unknown';
}

async function postEvent(event: SessionEvent): Promise<void> {
  logger.info('session_event', event);

  if (!brainApiUrl) return;

  const response = await fetch(`${brainApiUrl}/v1/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(localAgentToken ? { 'x-local-agent-token': localAgentToken } : {})
    },
    body: JSON.stringify({ event })
  });

  if (!response.ok) {
    logger.error('event_post_failed', {
      status: response.status,
      status_text: response.statusText
    });
  }
}

async function ackCommand(command: BrainCommand, status: CommandAck['status']): Promise<void> {
  if (!brainApiUrl) return;

  const ack: CommandAck = {
    command_id: command.command_id,
    session_id: command.session_id,
    task_id: command.task_id,
    status,
    client_timestamp: new Date().toISOString(),
    correlation_id: command.correlation_id,
    details: { client: 'voice' }
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

async function handleCommand(command: BrainCommand): Promise<void> {
  logger.info('command_received', {
    command_id: command.command_id,
    action: command.action,
    target: command.target
  });

  await ackCommand(command, 'received');
  await ackCommand(command, 'processed');
}

async function subscribeBrainCommands(sessionId: string): Promise<void> {
  if (!brainApiUrl) return;

  const streamUrl = `${brainApiUrl}/v1/commands/stream?session_id=${encodeURIComponent(sessionId)}&client=voice`;
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
        await handleCommand(parsed);
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

async function runTextSession(
  emitter: SessionEventEmitter,
  prompt: string,
  model: string
): Promise<void> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  await postEvent(
    emitter.next('turn_sent', {
      prompt,
      mode: 'text'
    })
  );

  const response = await ai.models.generateContent({
    model,
    contents: prompt
  });

  await postEvent(
    emitter.next('turn_received', {
      text: response.text ?? '',
      usage: response.usageMetadata ?? null
    })
  );
}

async function runMicrophoneSession(emitter: SessionEventEmitter): Promise<void> {
  await postEvent(
    emitter.next('error', {
      category: 'model',
      message: 'microphone mode placeholder: local microphone capture pipeline not implemented yet'
    })
  );
}

export async function runLiveTest(mode: LiveMode, prompt = 'hello from live-test'): Promise<void> {
  const sessionId = `sess-${Date.now()}`;
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  const emitter = new SessionEventEmitter(sessionId, mode === 'text' ? 'T02C-TEXT' : 'T02C-MIC', crypto.randomUUID());

  // Keep control stream optional for quick local test mode.
  if (process.env.VOICE_ENABLE_CONTROL_STREAM === 'true') {
    void subscribeBrainCommands(sessionId).catch((error) => {
      logger.error('command_stream_error', { message: String(error) });
    });
  }

  await postEvent(
    emitter.next('session_open', {
      mode,
      model
    })
  );

  try {
    if (mode === 'text') {
      await runTextSession(emitter, prompt, model);
    } else {
      await runMicrophoneSession(emitter);
    }

    await postEvent(emitter.next('session_closed', { reason: 'normal', mode }));
  } catch (error) {
    await postEvent(
      emitter.next('error', {
        category: classifyError(error),
        message: String(error)
      })
    );
    process.exitCode = 1;
  }
}

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

if (process.argv.includes('--live-test')) {
  const requestedMode = parseArg('mode');
  const mode: LiveMode = requestedMode === 'mic' ? 'mic' : 'text';
  const prompt = parseArg('prompt') ?? 'hello from live-test';

  runLiveTest(mode, prompt).catch((error) => {
    logger.error('live_test_failure', { message: String(error) });
    process.exit(1);
  });
} else {
  console.log('voice-gateway ready. use --live-test --mode=text|mic for session tests.');
}
