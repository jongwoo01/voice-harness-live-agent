insert into conversation (session_id, channel, metadata)
values ('seed-session-001', 'text', '{"source":"seed"}'::jsonb)
on conflict (session_id) do nothing;

insert into state_snapshot (session_id, snapshot_version, state)
values ('seed-session-001', 1, '{"stage":"initialized"}'::jsonb)
on conflict (session_id, snapshot_version) do nothing;
