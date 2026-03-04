import type { AgentEvent, BrainCommand, CommandAck, CommandTargetClient } from './events.js';

export type BrainSessionCreateRequest = {
  session_id: string;
  channel: 'voice' | 'text';
  metadata?: Record<string, unknown>;
};

export type BrainSessionCreateResponse = {
  session_id: string;
  channel: 'voice' | 'text';
  created_at: string;
};

export type BrainPlanTaskRequest = {
  session_id: string;
  task_id: string;
  user_goal: string;
};

export type BrainPlanTaskResponse = {
  task_id: string;
  next_action: {
    command: string;
    expected_result: string;
  };
};

export type ApprovalRequest = {
  session_id: string;
  task_id: string;
  command: string;
  approved: boolean;
  approved_by: string;
  reason?: string;
};

export type ApprovalResponse = {
  ok: boolean;
  approved: boolean;
};

export type BrainEventIngestRequest = {
  event: AgentEvent;
};

export type BrainEventIngestResponse = {
  ingested: boolean;
  type: AgentEvent['type'];
};

export type BrainCommandStreamResponse = {
  connected: boolean;
  session_id: string;
  client: CommandTargetClient;
};

export type BrainCommandAckRequest = {
  ack: CommandAck;
};

export type BrainCommandAckResponse = {
  ok: boolean;
  command_id: string;
  status: CommandAck['status'];
};

export type BrainCommandEmitRequest = {
  command: BrainCommand;
};
