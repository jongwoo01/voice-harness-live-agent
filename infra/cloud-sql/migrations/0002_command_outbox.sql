create table if not exists command_outbox (
  command_id text primary key,
  session_id text not null,
  task_id text not null,
  target_client text not null check (target_client in ('voice', 'executor', 'terminal')),
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  correlation_id text not null,
  expires_at timestamptz not null,
  status text not null check (status in ('queued', 'sent', 'acked', 'expired', 'failed')),
  attempt_count int not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  acked_at timestamptz
);

create index if not exists idx_command_outbox_session_id on command_outbox(session_id);
create index if not exists idx_command_outbox_status_next on command_outbox(status, next_attempt_at);
create index if not exists idx_command_outbox_task_id on command_outbox(task_id);
