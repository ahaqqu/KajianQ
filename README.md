# Agentic Project Template

Working full-stack starter for AI-assisted product development: Cloudflare Workers + React PWA + agent skills.

**Tracer feature:** local-first **Notes** CRUD (create / read / update-via-sync / delete) with D1 sync. Payments are out of scope for this template.

## Purpose

| Goal | How |
|---|---|
| Cheap | Cloudflare free tier |
| Offline-first | LWW merge (`@app/local-first`) + IndexedDB + batched `/v1/sync` |
| Fast | Bundle &lt;200 KB gzip; PWA |
| Agent-ready | Valibot contracts, adapters, ≤300-line files, skill pipeline |
| Quality | Unit, property, BDD, size-limit, security CI |

Docs: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`AGENTS.md`](AGENTS.md) · [`CONTEXT.md`](CONTEXT.md)

## Stack

| Layer | Choice |
|---|---|
| Edge | Workers + Static Assets + D1 + R2 + Cron |
| API | Hono `/v1/*` |
| Web | React 19 + TanStack Router/Query + Tailwind + PWA |
| Contracts | Valibot (`packages/contracts`) + hono-openapi |
| Sync | `mergeNotes` + leader election + BroadcastChannel |
| Infra | Logger, ObjectStore, ConfigStore, RateLimiter |
| Auth | Anonymous session in D1 (Bearer); cascade delete |
| Tests | Vitest + fast-check + Playwright-BDD |

## Setup a new project

```bash
bun install
cp .env.example .env   # or create .env with CF tokens
# edit apps/api/wrangler.toml name + D1/R2 ids if forking
bunx wrangler d1 create <your-db>
bunx wrangler r2 bucket create <your-bucket>
bun run db:migrate:local
bunx wrangler d1 migrations apply <your-db> --remote -c apps/api/wrangler.toml
bun run check && bun run test && bun run e2e
bun run deploy
```

`.env` (gitignored):

```bash
CLOUDFLARE_ACCOUNT_ID=…
CLOUDFLARE_API_TOKEN=…   # Workers Scripts:Edit, D1:Edit, R2:Edit
```

Error tracking is optional and DSN-gated (Sentry free tier). With no DSNs set, the SDKs stay disabled:

```bash
bunx wrangler secret put SENTRY_DSN    # Worker errors (per env)
VITE_SENTRY_DSN=… bun run build        # web errors-only; Session Replay is opt-in
```

## Develop a product

```
grill-with-docs → to-spec → to-tickets → plan-review
  → guided-implementation → writing-tests → pr-creation
  → code-review → ship
```

For the full pipeline and when to use each skill, invoke the `agentic-workflow` skill (`.agents/skills/agentic-workflow/SKILL.md`).

Extend **Notes** patterns: contracts in `packages/contracts` → D1 migration + client migration + `SCHEMA_VERSION` → route under `/v1/` → UI route → BDD.

### Commands

| Command | Use |
|---|---|
| `bun run dev` | Build web + wrangler dev |
| `bun run check` | Typecheck |
| `bun run test` | Unit + property + coverage |
| `bun run e2e` | Playwright-BDD |
| `bun run size-limit` | Bundle budget |
| `bun run agentic-limits` | File size / import caps |
| `bun run truth` | No dependency without an importer |
| `bun run deploy` | Production Worker |
| `bun run deploy:staging` | Staging |

### API surface

- `GET /v1/health`
- `POST /v1/auth/anonymous`
- `DELETE /v1/auth/me`
- `GET /v1/notes`
- `POST /v1/sync`
- `GET /openapi.json`

## Architecture coverage (template)

| Band | Status |
|---|---|
| P0 core (D1, sync, BDD, security CI, Valibot contracts) | Done |
| P1 (auth session, CORS, adapters/R2, router, PWA, staging workflows) | Done |
| P2 (lint limits, restore runbook, ZAP/fuzz workflows, quota doc) | Done |
| P3 except payments (rate limit, account cascade delete) | Done |
| Payments (Xendit/Polar) | **Omitted** |

## Ops docs

- [`docs/RUNBOOK_RESTORE.md`](docs/RUNBOOK_RESTORE.md) — D1 Time Travel + R2 backups  
- [`docs/QUOTA.md`](docs/QUOTA.md) — free-tier monitoring  
