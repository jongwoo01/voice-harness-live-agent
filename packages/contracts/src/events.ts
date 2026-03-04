export type EventSource = 'terminal' | 'voice-gateway' | 'brain-api' | 'executor-local' | 'system';
export type CommandTargetClient = 'voice' | 'executor' | 'terminal';

export type SessionEventType = 'session_open' | 'turn_sent' | 'turn_received' | 'session_closed' | 'error';
export type ExecutionEventType = 'permission_needed' | 'execution_started' | 'execution_completed' | 'execution_failed';
export type CommandAckStatus = 'received' | 'processed' | 'failed';

export type BaseEvent = {
  event_id: string;
  session_id: string;
  task_id: string;
  timestamp: string;
  source: EventSource;
  sequence: number;
  correlation_id: string;
  payload: Record<string, unknown>;
};

export type SessionEvent = BaseEvent & {
  type: SessionEventType;
};

export type ExecutionEvent = BaseEvent & {
  type: ExecutionEventType;
};

export type AgentEvent = SessionEvent | ExecutionEvent;

export type BrainCommand = {
  command_id: string;
  session_id: string;
  task_id: string;
  target: CommandTargetClient;
  action: string;
  payload: Record<string, unknown>;
  correlation_id: string;
  created_at: string;
  expires_at: string;
};

export type CommandAck = {
  command_id: string;
  session_id: string;
  task_id: string;
  status: CommandAckStatus;
  client_timestamp: string;
  correlation_id: string;
  details?: Record<string, unknown>;
};

export type TaskStatus = 'TODO' | 'DOING' | 'BLOCKED' | 'DONE';

export type AgentStatus = {
  session_id: string;
  task_id: string;
  stage: string;
  updated_at: string;
};

const SESSION_TYPES = new Set<SessionEventType>([
  'session_open',
  'turn_sent',
  'turn_received',
  'session_closed',
  'error'
]);

const EXECUTION_TYPES = new Set<ExecutionEventType>([
  'permission_needed',
  'execution_started',
  'execution_completed',
  'execution_failed'
]);

export function isSessionEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: string }).type;
  return typeof type === 'string' && SESSION_TYPES.has(type as SessionEventType);
}

export function isExecutionEvent(value: unknown): value is ExecutionEvent {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: string }).type;
  return typeof type === 'string' && EXECUTION_TYPES.has(type as ExecutionEventType);
}

export function isBrainCommand(value: unknown): value is BrainCommand {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BrainCommand>;
  return (
    typeof candidate.command_id === 'string' &&
    typeof candidate.session_id === 'string' &&
    typeof candidate.task_id === 'string' &&
    typeof candidate.target === 'string' &&
    typeof candidate.action === 'string' &&
    typeof candidate.correlation_id === 'string' &&
    typeof candidate.created_at === 'string' &&
    typeof candidate.expires_at === 'string' &&
    !!candidate.payload &&
    typeof candidate.payload === 'object'
  );
}

export function isCommandAck(value: unknown): value is CommandAck {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CommandAck>;
  return (
    typeof candidate.command_id === 'string' &&
    typeof candidate.session_id === 'string' &&
    typeof candidate.task_id === 'string' &&
    typeof candidate.client_timestamp === 'string' &&
    typeof candidate.correlation_id === 'string' &&
    (candidate.status === 'received' || candidate.status === 'processed' || candidate.status === 'failed')
  );
}
