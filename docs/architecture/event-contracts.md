# Event Contracts

## AgentEvent base fields

- `event_id`: unique event id (uuid)
- `session_id`: conversation/session id
- `task_id`: task correlation id
- `timestamp`: ISO-8601 timestamp
- `source`: emitting component
- `sequence`: monotonically increasing sequence in a session
- `correlation_id`: request/response correlation id
- `payload`: event-specific JSON

## Session events

- `session_open`
- `turn_sent`
- `turn_received`
- `session_closed`
- `error`

## Execution events

- `permission_needed`
- `execution_started`
- `execution_completed`
- `execution_failed`

## BrainCommand

- `command_id`
- `session_id`
- `task_id`
- `target` (`voice|executor|terminal`)
- `action`
- `payload`
- `correlation_id`
- `created_at`
- `expires_at`

## CommandAck

- `command_id`
- `session_id`
- `task_id`
- `status` (`received|processed|failed`)
- `client_timestamp`
- `correlation_id`
- `details` (optional)

## Brain HTTP interfaces

- `GET /v1/health`
- `POST /v1/sessions`
- `POST /v1/tasks/plan`
- `POST /v1/tasks/:id/approve`
- `POST /v1/events`
- `GET /v1/commands/stream?session_id=...&client=voice|executor|terminal`
- `POST /v1/commands/:command_id/ack`
