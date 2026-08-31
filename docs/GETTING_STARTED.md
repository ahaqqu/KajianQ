# Getting Started

How to set up and run this template. For what this is and why it works this way, see [`README.md`](../README.md) and [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).

## Prerequisites

- [Bun](https://bun.sh) as the package manager and runtime
- A Cloudflare account with Workers, D1, and R2 enabled

## Set up a new project

```bash
bun install
cp .env.example .env   # or create .env with CF tokens
# edit apps/api/wrangler.toml name + D1/R2 ids if forking
bunx wrangler d1 create <your-db>          # prints a UUID
bunx wrangler r2 bucket create <your-bucket>
bun run db:migrate:local
bunx wrangler d1 migrations apply DB --remote -c apps/api/wrangler.toml   # uses the binding, not the name
bun run check && bun run test && bun run e2e
bun run deploy
```

`.env` (gitignored):

```bash
CLOUDFLARE_ACCOUNT_ID=…
CLOUDFLARE_API_TOKEN=…   # Workers Scripts:Edit, D1:Edit, R2:Edit
```

> **D1 `database_id`:** `wrangler.toml` ships a `replace-me-with-your-d1-uuid`
> sentinel. Replace it with the UUID from `wrangler d1 create` before your
> first remote deploy, or inject the UUID via a CI secret at deploy time
> (wrangler does not interpolate env vars in `wrangler.toml` — substitute
> the value before calling `wrangler deploy`). Local dev uses the
> `preview_database_id` field and is unaffected.

Error tracking is optional and DSN-gated (Sentry free tier). With no DSNs set, the SDKs stay disabled:

```bash
bunx wrangler secret put SENTRY_DSN    # Worker errors (per env)
VITE_SENTRY_DSN=… bun run build        # web errors-only; Session Replay is opt-in
```

## Keep in sync with template updates

Template changes (skills, guardrails, workflows, docs) flow into forked projects via `scripts/template-sync/cli.mjs`. `template-sync.json` declares ownership: **overwrite** paths are template-owned and enforced — forks inherit the template-shipped files, syncs always take the template version, and `bun run template-gate` (CI) fails when a fork modifies or deletes one; fork *additions* under overwrite directories (e.g. your own skills in `.agents/skills/`) are allowed and stay green — only template-shipped files are enforced; **merge** paths (`apps/`, `packages/`, `package.json`, `README.md`, `CONTEXT.md`) merge normally; unlisted paths are project-owned and never synced.

```bash
bun run template-sync init     # add + fetch the upstream remote (once)
bun run template-sync check    # gate: fail on template-owned drift
bun run template-sync update   # merge latest template release (--ref=X to pin)
bun run template-sync finish   # complete a sync after resolving conflicts
```

The `template-sync` workflow (`.github/workflows/template-sync.yml`) opens a sync PR weekly. If it reports conflicts, check out the `template-sync` branch, resolve them, then run `bun run template-sync finish`. To sync from a different upstream URL, set the `TEMPLATE_SYNC_UPSTREAM` environment variable. Do not edit `template-sync.json` in a fork: it is template-owned and the gate will flag any drift.

## Commands

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
