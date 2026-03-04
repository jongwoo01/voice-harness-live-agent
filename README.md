# Google Live Agent Monorepo

레이어드 아키텍처 기반 모노레포입니다.

## Structure

- `apps/terminal`: 사용자 터미널 UI (Ink/Commander)
- `apps/voice-gateway`: Gemini Live 세션 게이트웨이
- `apps/brain-api`: Brain API (Cloud Run 배포 대상)
- `apps/executor-local`: 로컬 명령 실행 레이어
- `packages/contracts`: 이벤트/DTO 계약
- `packages/memory-pg`: PostgreSQL 저장소 접근 모듈
- `packages/observability`: 공통 로깅 유틸
- `infra/cloud-run`: Brain 배포 스크립트
- `infra/cloud-sql`: Cloud SQL 마이그레이션 스크립트

## Quick Start

```bash
npm install
npm run dev:terminal
npm run -w apps/brain-api build
```
