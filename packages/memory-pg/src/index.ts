import { Pool } from 'pg';
import type { AgentEvent, ApprovalRequest, BrainCommand, CommandAck, TaskStatus } from '@google-live-agent/contracts';

type OutboxStatus = 'queued' | 'sent' | 'acked' | 'expired' | 'failed';

type OutboxRecord = {
  command: BrainCommand;
  status: OutboxStatus;
  attemptCount: number;
  nextAttemptAt: number;
  ackedAt?: string;
};

export type TaskPermissionTimelineEntry = {
  task_id: string;
  session_id: string;
  event_type: string;
  status: string;
  message: string;
  event_payload: Record<string, unknown>;
  permission_command: string | null;
  permission_reason: string | null;
  permission_approved: boolean | null;
  permission_approved_by: string | null;
  permission_created_at: string | null;
  permission_resolved_at: string | null;
  created_at: string;
};

export class PostgresMemoryStore {
  private readonly pool: Pool | null;
  private readonly fallbackOutbox = new Map<string, OutboxRecord>();

  constructor(private readonly connectionString?: string) {
    this.pool = connectionString
      ? new Pool({
          connectionString,
          ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
        })
      : null;
  }

  async ping(): Promise<'connected' | 'not_configured' | 'error'> {
    if (!this.pool) return 'not_configured';
    try {
      await this.pool.query('select 1');
      return 'connected';
    } catch {
      return 'error';
    }
  }

  async saveEvent(event: AgentEvent): Promise<void> {
    if (!this.pool) return;

    const statusMap: Partial<Record<AgentEvent['type'], TaskStatus>> = {
      permission_needed: 'BLOCKED',
      execution_started: 'DOING',
      execution_completed: 'DONE',
      execution_failed: 'BLOCKED'
    };

    await this.pool.query(
      `
      insert into task_log (id, task_id, session_id, status, event_type, message, payload, created_at)
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
      `,
      [
        event.event_id,
        event.task_id,
        event.session_id,
        statusMap[event.type] ?? 'DOING',
        event.type,
        `${event.source}:${event.type}`,
        JSON.stringify({
          ...event.payload,
          sequence: event.sequence,
          correlation_id: event.correlation_id
        })
      ]
    );

    if (event.type === 'permission_needed') {
      await this.pool.query(
        `
        insert into permission_request (id, task_id, command, reason, approved, approved_by, created_at)
        values ($1, $2, $3, $4, null, null, now())
        `,
        [
          crypto.randomUUID(),
          event.task_id,
          String(event.payload.command ?? ''),
          String(event.payload.reason ?? '')
        ]
      );
    }
  }

  async savePermissionDecision(input: ApprovalRequest): Promise<void> {
    if (!this.pool) return;

    await this.pool.query(
      `
      update permission_request
      set approved = $1,
          approved_by = $2,
          resolved_at = now()
      where task_id = $3 and command = $4 and resolved_at is null
      `,
      [input.approved, input.approved_by, input.task_id, input.command]
    );
  }

  async enqueueCommand(command: BrainCommand): Promise<void> {
    if (!this.pool) {
      this.fallbackOutbox.set(command.command_id, {
        command,
        status: 'queued',
        attemptCount: 0,
        nextAttemptAt: Date.now()
      });
      return;
    }

    await this.pool.query(
      `
      insert into command_outbox (
        command_id,
        session_id,
        task_id,
        target_client,
        action,
        payload,
        correlation_id,
        expires_at,
        status,
        attempt_count,
        next_attempt_at,
        created_at
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz, 'queued', 0, now(), now())
      on conflict (command_id) do nothing
      `,
      [
        command.command_id,
        command.session_id,
        command.task_id,
        command.target,
        command.action,
        JSON.stringify(command.payload),
        command.correlation_id,
        command.expires_at
      ]
    );
  }

  async markCommandDispatched(commandId: string): Promise<void> {
    if (!this.pool) {
      const record = this.fallbackOutbox.get(commandId);
      if (!record) return;
      record.status = 'sent';
      record.attemptCount += 1;
      record.nextAttemptAt = Date.now() + 5_000;
      this.fallbackOutbox.set(commandId, record);
      return;
    }

    await this.pool.query(
      `
      update command_outbox
      set status = 'sent',
          attempt_count = attempt_count + 1,
          next_attempt_at = now() + interval '5 seconds'
      where command_id = $1 and status in ('queued', 'sent')
      `,
      [commandId]
    );
  }

  async ackCommand(ack: CommandAck): Promise<void> {
    if (!this.pool) {
      const record = this.fallbackOutbox.get(ack.command_id);
      if (!record) return;
      record.status = ack.status === 'failed' ? 'failed' : 'acked';
      record.ackedAt = ack.client_timestamp;
      this.fallbackOutbox.set(ack.command_id, record);
      return;
    }

    await this.pool.query(
      `
      update command_outbox
      set status = $2,
          acked_at = $3::timestamptz,
          next_attempt_at = case when $2 = 'failed' then now() + interval '5 seconds' else next_attempt_at end
      where command_id = $1
      `,
      [ack.command_id, ack.status === 'failed' ? 'failed' : 'acked', ack.client_timestamp]
    );
  }

  async markExpiredCommands(): Promise<void> {
    if (!this.pool) {
      const now = Date.now();
      for (const record of this.fallbackOutbox.values()) {
        if (record.status !== 'acked' && Date.parse(record.command.expires_at) <= now) {
          record.status = 'expired';
        }
      }
      return;
    }

    await this.pool.query(
      `
      update command_outbox
      set status = 'expired'
      where status in ('queued', 'sent', 'failed')
        and expires_at <= now()
      `
    );
  }

  async getRetryableCommands(limit = 50): Promise<BrainCommand[]> {
    if (!this.pool) {
      const now = Date.now();
      return Array.from(this.fallbackOutbox.values())
        .filter((record) => {
          if (record.status === 'acked' || record.status === 'expired') return false;
          if (Date.parse(record.command.expires_at) <= now) {
            record.status = 'expired';
            return false;
          }
          return record.status === 'queued' || record.nextAttemptAt <= now;
        })
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
        .slice(0, limit)
        .map((record) => record.command);
    }

    const result = await this.pool.query<{
      command_id: string;
      session_id: string;
      task_id: string;
      target_client: BrainCommand['target'];
      action: string;
      payload: Record<string, unknown>;
      correlation_id: string;
      created_at: string;
      expires_at: string;
    }>(
      `
      select
        command_id,
        session_id,
        task_id,
        target_client,
        action,
        payload,
        correlation_id,
        created_at,
        expires_at
      from command_outbox
      where status in ('queued', 'sent', 'failed')
        and next_attempt_at <= now()
        and expires_at > now()
      order by next_attempt_at asc
      limit $1
      `,
      [limit]
    );

    return result.rows.map((row) => ({
      command_id: row.command_id,
      session_id: row.session_id,
      task_id: row.task_id,
      target: row.target_client,
      action: row.action,
      payload: row.payload,
      correlation_id: row.correlation_id,
      created_at: row.created_at,
      expires_at: row.expires_at
    }));
  }

  async getPendingCommandsForSubscriber(
    sessionId: string,
    target: BrainCommand['target'],
    limit = 50
  ): Promise<BrainCommand[]> {
    if (!this.pool) {
      const now = Date.now();
      return Array.from(this.fallbackOutbox.values())
        .filter((record) => {
          if (record.command.session_id !== sessionId) return false;
          if (record.command.target !== target) return false;
          if (record.status === 'acked' || record.status === 'expired') return false;
          if (Date.parse(record.command.expires_at) <= now) {
            record.status = 'expired';
            return false;
          }
          return true;
        })
        .slice(0, limit)
        .map((record) => record.command);
    }

    const result = await this.pool.query<{
      command_id: string;
      session_id: string;
      task_id: string;
      target_client: BrainCommand['target'];
      action: string;
      payload: Record<string, unknown>;
      correlation_id: string;
      created_at: string;
      expires_at: string;
    }>(
      `
      select
        command_id,
        session_id,
        task_id,
        target_client,
        action,
        payload,
        correlation_id,
        created_at,
        expires_at
      from command_outbox
      where session_id = $1
        and target_client = $2
        and status in ('queued', 'sent', 'failed')
        and expires_at > now()
      order by created_at asc
      limit $3
      `,
      [sessionId, target, limit]
    );

    return result.rows.map((row) => ({
      command_id: row.command_id,
      session_id: row.session_id,
      task_id: row.task_id,
      target: row.target_client,
      action: row.action,
      payload: row.payload,
      correlation_id: row.correlation_id,
      created_at: row.created_at,
      expires_at: row.expires_at
    }));
  }

  async getTaskPermissionTimeline(sessionId: string, taskId: string): Promise<TaskPermissionTimelineEntry[]> {
    if (!this.pool) return [];

    const result = await this.pool.query<TaskPermissionTimelineEntry>(
      `
      select
        tl.task_id,
        tl.session_id,
        tl.event_type,
        tl.status,
        tl.message,
        tl.payload as event_payload,
        pr.command as permission_command,
        pr.reason as permission_reason,
        pr.approved as permission_approved,
        pr.approved_by as permission_approved_by,
        pr.created_at::text as permission_created_at,
        pr.resolved_at::text as permission_resolved_at,
        tl.created_at::text as created_at
      from task_log tl
      left join permission_request pr on pr.task_id = tl.task_id
      where tl.session_id = $1 and tl.task_id = $2
      order by tl.created_at asc
      `,
      [sessionId, taskId]
    );

    return result.rows;
  }
}
