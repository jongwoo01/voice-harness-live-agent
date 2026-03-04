create extension if not exists pgcrypto;

create table if not exists conversation (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  channel text not null check (channel in ('voice', 'text')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists task_log (
  id uuid primary key,
  task_id text not null,
  session_id text not null,
  status text not null check (status in ('TODO', 'DOING', 'BLOCKED', 'DONE')),
  event_type text not null,
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_task_log_task_id on task_log(task_id);
create index if not exists idx_task_log_session_id on task_log(session_id);
create index if not exists idx_task_log_created_at on task_log(created_at desc);

create table if not exists state_snapshot (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  snapshot_version int not null,
  state jsonb not null,
  created_at timestamptz not null default now(),
  unique(session_id, snapshot_version)
);

create index if not exists idx_state_snapshot_session_id on state_snapshot(session_id);

create table if not exists permission_request (
  id uuid primary key,
  task_id text not null,
  command text not null,
  reason text not null,
  approved boolean,
  approved_by text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists idx_permission_request_task_id on permission_request(task_id);
create index if not exists idx_permission_request_open on permission_request(task_id) where resolved_at is null;
