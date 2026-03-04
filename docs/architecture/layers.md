# Layered Architecture

## Deployment placement

- Terminal Layer: local machine
- Voice Layer: local machine (Gemini Live gateway)
- Brain Layer: Cloud Run (single service)
- Execution Layer: local machine only
- Memory Layer: Cloud SQL PostgreSQL

## Runtime model (Dual-channel)

- Data plane: `voice-gateway -> Gemini API` direct path for model I/O/audio/text.
- Control plane: `voice/executor/terminal <-> brain-api` via `HTTPS POST + SSE`.

Brain does not proxy raw audio. Brain receives summarized events/transcripts and publishes commands.

## Responsibility map

1. Terminal (`apps/terminal`)
- render status and approval prompts
- send approval decisions to Brain API

2. Voice (`apps/voice-gateway`)
- run text/microphone session modes
- post session events (`/v1/events`)
- subscribe command stream (`/v1/commands/stream`)

3. Brain (`apps/brain-api`)
- policy/state-machine and event ingestion
- SSE command fanout + outbox retry + ACK handling
- permission routing to terminal/executor

4. Executor (`apps/executor-local`)
- local command execution with policy guard (allowlist/denylist/workdir/timeout)
- permission queue and approval-gated execution
- command ACK (`/v1/commands/:id/ack`)

5. Memory (`packages/memory-pg`)
- persist `task_log`, `permission_request`, `command_outbox`
- retry and audit support for control-plane delivery

## Runtime contracts

All inter-layer events/commands use `@google-live-agent/contracts`.
