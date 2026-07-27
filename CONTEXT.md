# CONTEXT

Mental model for agents working in this repo.

## What this is

Working monorepo proving `docs/ARCHITECTURE.md` via a **Notes** CRUD vertical slice (payments intentionally omitted).

## Layout

- `apps/api` — Hono Worker: health, anonymous auth, notes list, sync, OpenAPI; ASSETS for SPA; D1 + R2; cron backup
- `apps/web` — React PWA + TanStack Router (`/`, `/notes`); IndexedDB notes; leader sync; en/id
- `packages/shared-zod` — Health, Note, Sync, Auth contracts
- `packages/sync-protocol` — `SCHEMA_VERSION=2`, `mergeNotes` (+ property tests)
- `packages/infra` — Logger, ObjectStore, ConfigStore, Cache, JobScheduler, RateLimiter, Sentry facade
- `packages/db-schema` — users, sessions, notes, rate_limits + SQL migration
- `tests/features` — Playwright-BDD

## Gates

`bun run check` · `bun run test` · `bun run size-limit` · `bun run agentic-limits` · `bun run e2e` · `bun run deploy`

## Auth model

Anonymous session: `POST /v1/auth/anonymous` → Bearer token in D1. Account delete: `DELETE /v1/auth/me` cascades notes/sessions. (Better Auth OAuth can replace this adapter later.)
