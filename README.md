# Google Live Agent Monorepo

Layered monorepo for a voice-driven live agent architecture.

## Structure

- `apps/terminal`: user-facing terminal UI (Ink/Commander)
- `apps/voice-gateway`: Gemini Live session gateway
- `apps/brain-api`: Brain API (Cloud Run deployment target)
- `apps/executor-local`: local command execution layer
- `packages/contracts`: shared event/DTO contracts
- `packages/memory-pg`: PostgreSQL memory/repository module
- `packages/observability`: shared logging utilities
- `infra/cloud-run`: Brain deployment scripts
- `infra/cloud-sql`: Cloud SQL migration scripts

## Quick Start

```bash
npm install
npm run dev:terminal
npm run -w apps/brain-api build
```
