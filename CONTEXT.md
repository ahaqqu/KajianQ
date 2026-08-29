# CONTEXT

Mental model for agents working in this repo.

## What this is

Working monorepo proving `docs/ARCHITECTURE.md` via a **Notes** CRUD vertical slice (payments intentionally omitted).

## Layout

- `apps/api` — Hono Worker: health, anonymous auth, notes list, sync, OpenAPI; ASSETS for SPA; D1 + R2; cron backup; raw-SQL migrations in `migrations/`
- `apps/web` — React PWA + TanStack Router (`/`, `/notes`); IndexedDB notes; leader sync; en/id
- `packages/contracts` — Health, Note, Sync, Auth contracts (Valibot)
- `packages/local-first` — `SCHEMA_VERSION=2`, LWW `mergeNotes` (+ property tests), clock discipline, tombstone GC, note-mapper; `/client` entrypoint: leader election, sync loop, persistence, migrations
- `packages/infra` — Logger, ObjectStore, ConfigStore adapters
- `packages/rate` — Rate limiting (`RateLimiter` adapters, `RateLimiterDo`); reusable across forks via template-sync
- `tests/features` — Playwright-BDD

## Gates

`bun run check` · `bun run test` · `bun run size-limit` · `bun run agentic-limits` · `bun run truth` · `bun run e2e` · `bun run deploy`

## Auth model

Anonymous session: `POST /v1/auth/anonymous` → Bearer token in D1. Account delete: `DELETE /v1/auth/me` cascades notes/sessions. (Better Auth OAuth can replace this adapter later.)

## Agentic pipeline

Skill pipeline lives in `.agents/skills/` (router: `agentic-workflow`). Multi-agent orchestration lives in `manager` (spawns role subagents per phase; role models configured in `.zcode/agents/`). Reviews route through `code-review` — the single review entry point; thermos depth is mandatory for code-touching PRs, skippable only for docs/skill/non-code changes. Findings can be posted as itemized PR comments via `thermos-with-comments` (the manager's reviewer role).
