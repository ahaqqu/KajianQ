# ADR-0028: Alchemy owns Cloudflare provisioning and deploys; wrangler stays for local dev

## Status

Accepted (2026-09-05). Companion to ADR-0027 (Effect adoption in engine packages + API): Alchemy v2 is itself Effect-based ("Infrastructure as Effects"), but the Effect it runs is deploy-side tooling under Bun and does not pre-empt or accelerate ADR-0027's engine migration phases. Owner-directed adoption (alchemy.run getting-started).

## Context

Deployment today is hand-threaded:

- `apps/api/wrangler.toml` is the single hand-maintained description of the production topology — Worker `kajianq-api` (+ `env.staging`), compat `2025-07-01` + `nodejs_compat`, R2 binding `BUCKET` (`kajianq-raw` / `kajianq-raw-staging`), Durable Object `RATE_LIMITER` (`RateLimiterDo`, SQLite-backed, migration tag `v1`), static assets from `../web/dist` (SPA fallback, `run_worker_first`), vars (`APP_ENV`, `ALLOWED_ORIGINS`), observability on.
- Deploys are `wrangler deploy` via root scripts; one-time provisioning was `scripts/provision-cf.mjs` (buckets + repo variables); secrets (`DASHSCOPE_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `MOONSHOT_API_KEY`, `SENTRY_DSN`) were applied out-of-band via `wrangler secret`.
- `.github/workflows/deploy.yml` is **already broken**: it invokes `bun run deploy:inject` (no such script) and `wrangler d1 migrations apply` (wrangler.toml has no D1 — vestigial template heritage; persistence is Neon by ADR-0008). It is `workflow_dispatch`-only, so nothing has exercised the breakage.
- Local dev and e2e run `wrangler dev` (`playwright.config.ts` webServer; `e2e.yml` is template-owned and must not change).
- Neon Postgres is provisioned outside the repo and holds the corpus — it is never touched by deploy tooling (data-integrity guardrail; ADR-0020 plan sizing).

Alchemy (npm `alchemy`, Apache-2.0) is TypeScript-native IaC. The live `alchemy.run` documents the **v2 rewrite**, Effect-native end to end; current release `2.0.0-beta.76` (the v1 API is archived at `v1.alchemy.run`). Adoption was verified against the installed package's types: `Stack`/`Stage`, `Cloudflare.Worker` (`main`, `name`, `compatibility: { date, flags }`, `assets` with `notFoundHandling`/`runWorkerFirst` and an auto-injected `ASSETS` binding, `env` accepting `effect/Config` values bound as `secret_text`), `Cloudflare.R2.Bucket` (`name`, `forceDestroy`), `Cloudflare.DurableObject` bindings for plain `cloudflare:workers` classes with automatic migration metadata, `Cloudflare.state()` (Worker + Durable Object state store, CI auth via Cloudflare Secrets Store), and the `alchemy deploy [file] --stage <stage>` CLI under Bun.

## Decision

1. **Single stack file: `apps/api/alchemy.run.ts`.** It declares the whole Cloudflare topology: the Worker (`main: ./src/index.ts`, compat date `2025-07-01`, `nodejs_compat`, assets `../web/dist` with `single-page-application` fallback and `runWorkerFirst: true`, observability enabled), the R2 bucket, and the bindings the code consumes — `BUCKET` (bucket resource), `RATE_LIMITER` (`Cloudflare.DurableObject` with `className: "RateLimiterDo"`; alchemy derives the class migration), `ASSETS` (auto-injected by the `assets` prop), `APP_ENV`/`ALLOWED_ORIGINS` (plain text), and the five secrets (`SENTRY_DSN` + the four vendor API keys, `Config.redacted` → `secret_text`). Wrangler-era bindings cannot be silently dropped, because every binding the runtime reads is declared here.
2. **Physical names are pinned, and adoption is an explicit one-time step.** `prod` → `kajianq-api` + `kajianq-raw`; `staging` → `kajianq-api-staging` + `kajianq-raw-staging`. Any other stage fails the stack (no surprise buckets/workers from stray `--stage` values). Because the real resources already exist unmanaged, the first deploy runs `bun run deploy:bootstrap` (`alchemy deploy --adopt`) from an operator machine; CI deploys afterwards are plain `alchemy deploy`. The bucket is data-bearing (`forceDestroy: false` — raw source archives and `text_raw` backups), so `alchemy destroy` can never empty it.
3. **State store: `Cloudflare.state()`** — an account-local Worker + Durable Object with embedded SQLite (`alchemy-state-store`), bootstrapped on first operator deploy. Local stage state lands in gitignored `.alchemy/`; CI (`CI=true`) resolves state-store credentials from the Cloudflare Secrets Store per run. Encryption/secrets never enter the repo.
4. **Neon stays external.** The stack does not declare Neon resources; the database URL remains a runtime secret. A future ADR may add `Neon.Branch` for staging isolation — not now (free-tier project limits, ADR-0020 sizing, and no reason to point deploy tooling at the corpus).
5. **wrangler remains the local dev + e2e runner.** `wrangler.toml` stays (re-homed in purpose: it is the *dev/e2e* config) because `e2e.yml` is template-owned and Playwright boots `wrangler dev`. Dual source of truth is accepted and bounded: production shape is what the stack file declares; wrangler.toml drift only degrades dev fidelity. Revisit: move local dev to `alchemy dev` (and shrink wrangler.toml) once v2 stabilizes.
6. **Deploy pipeline.** Root `deploy` / `deploy:staging` become `bun run build` + the alchemy stage deploy (run with `apps/api` as cwd so asset paths resolve relative to the stack file); a `deploy:wrangler` fallback keeps the old path for rollback. `deploy.yml` drops the dead D1 steps and calls `bun run deploy` with the existing `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` secrets; the smoke-health steps are unchanged.

## Consequences

- `alchemy` is pinned at `2.0.0-beta.76` in `apps/api` (importer: the stack file). Beta risk is bounded: deploys are operator-triggered (`workflow_dispatch`), the wrangler fallback script remains, and every resource change goes through a reviewed PR diff of one TypeScript file.
- The stack file typechecks under the repo's TS 7 (`tsgo`) config — verified locally as part of this ADR's implementation; if a future alchemy beta breaks `tsgo`, the file can be excluded from `check` as deploy-time-only tooling (recorded here as the sanctioned escape hatch).
- Operator bootstrap is now part of the deploy path and is documented in the PR: `bun run deploy:bootstrap` once per account (also bootstraps the state store), then CI owns deploys. Secrets move to `secret_text` bindings on the first alchemy deploy; out-of-band `wrangler secret` values are superseded (idempotent either way — same names).
- Engine purity is unaffected: `alchemy` is a dev dependency of the product app, not any engine package; the boundary gate's scans are untouched.
- `alchemy deploy` plans before applying; a failed plan leaves production untouched, and `deploy:wrangler` + git revert are the rollback path.

## Revisit triggers

- Alchemy v2 reaches stable (or a breaking beta churns): bump the pin as a normal dependency PR.
- wrangler.toml drift causes a real dev/e2e fidelity bug: generate the dev config from the stack (or move local dev to `alchemy dev`) instead of hand-syncing.
- Staging needs database isolation: Neon via `Neon.Branch` gets its own ADR (data-integrity review first).
- CI state-store auth (`CI=true` + Cloudflare Secrets Store) proves flaky: fall back to a dedicated state-store token as a repo secret, or a Postgres state store.
