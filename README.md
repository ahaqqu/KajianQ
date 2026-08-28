# KajianQ

An open-source Islamic classical-knowledge chatbot for the Indonesian Muslim
public, built on **DARS** (*Dynamic Automated RAG Solution*) — a generic,
domain-agnostic RAG engine. Both live in this monorepo: DARS as workspace
packages under `packages/`, KajianQ as the product under `apps/`.

**Status:** v1 foundation. The deployable shell (Workers + React PWA + health +
OpenAPI) is up; the Smart RAG pipeline lands in the milestone tickets.

## Principles

- **Pluggable by design** — every external dependency and pipeline stage is
  replaceable by configuration, never by code edit.
- **Traceable by design** — every answer ships a full `Trace`; the machinery is
  never hidden.

See `AGENTS.md` for the standing rules, `SPECS.md` for the architecture &
plan (a living document), `docs/ARCHITECTURE.md` for the design rationale,
`CONTEXT.md` for the domain glossary, and `adr/` for the decisions.

## Layout

- `apps/api` — Hono Worker: `/v1/health`, OpenAPI; ASSETS serves the SPA; R2
  via the ObjectStore adapter. Persistence is Neon+pgvector behind the RagStore
  seam (ADR-0008), provisioned by #4.
- `apps/web` — React 19 PWA: TanStack Router/Query, Tailwind, en/id i18n,
  offline-capable shell.
- `packages/contracts` — Valibot contracts incl. the typed trace contract
  (`Trace`/`TraceEvent`/`CostRecord`, ADR-0007 amendment).
- `packages/rag-core` — pipeline interfaces: `Router`, `Retriever`,
  `Assembler`, `Generator`, `Reviewer`.
- `packages/rag-ingest` — ingestion pipeline skeleton.
- `packages/eval` — evaluation harness skeleton.
- `packages/infra` — adapters (Logger, ObjectStore, ConfigStore) plus the
  RagStore (ADR-0008) and Provider seams.
- `packages/rate` — `@app/rate`: RateLimiter adapter (Durable Object backend +
  bounded-memory fallback), shared via the template-sync merge path.
- `packages/hardening` — `@app/hardening`: security headers/CSP and ASSETS
  serving for the Hono Worker.
- `packages/kajianq-domain` — the KajianQ domain pack (all Islamic-domain
  logic lives here, never in the engine packages).

## Commands

| Command | Use |
|---|---|
| `bun run dev` | Build web + wrangler dev |
| `bun run check` | Typecheck all packages |
| `bun run test` | Unit + property + coverage |
| `bun run e2e` | Playwright-BDD smoke |
| `bun run boundary` | Engine domain/vendor/SQL boundary gate |
| `bun run size-limit` | Bundle budget |
| `bun run agentic-limits` | File size / import caps |
| `bun run truth` | No dependency without an importer |
| `bun run deploy:staging` | Deploy staging Worker |
| `bun run deploy` | Deploy production Worker |

## Setup

```bash
bun install
cp .env.example .env   # CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN
bun run check && bun run test && bun run e2e
```

Error tracking is optional and DSN-gated (Sentry); with no DSNs set the SDKs
stay disabled.

### Template sync

This repo was forked from
[`ahaqqu/agentic-project-template`](https://github.com/ahaqqu/agentic-project-template).
Upstream template fixes flow in via `bun run template-sync update`;
`template-sync.json` is the ownership map and `bun run template-gate` (CI)
fails on drift of template-owned files. See `AGENTS.md` and the template-sync
workflow.
