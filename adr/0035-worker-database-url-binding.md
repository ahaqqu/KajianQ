# ADR-0035: The Worker's DATABASE_URL binds from NEON_DATABASE_URL; staging CI requires it

## Status

Accepted (2026-09-09). Amends ADR-0028 (adds a binding to the stack map; Neon stays external — the stack still declares no Neon resource).

Tickets: none (CI repair: staging run 34300461139 failed when the DAST step fuzzed `/v1/chat` and hit the undocumented 503).

## Context

`/v1/chat` (#8/ADR-0034) builds its wiring from the Worker's `DATABASE_URL` binding and answers `503 chat_not_configured` when it is absent (`apps/api/src/lib/chat-wiring.ts`). But no deploy path ever supplied the binding: ADR-0028's `SECRET_NAMES` covers only `SENTRY_DSN` + the four vendor keys, and none of `deploy.yml` / `staging.yml` / `provision.yml` passes a database secret. The staging Worker therefore answered `503 chat_not_configured` on every chat request — by design "feature disabled", but invisible to the deploy pipeline until the schemathesis step, which fuzzes the served `openapi.json` unauthenticated and failed on the undocumented 503 (documented: 200/401).

Meanwhile the repo already holds the right secret: `NEON_DATABASE_URL` (used by the neon-contract CI job and the eval CLI, ADR-0034) points at the same shared Neon staging database the chat route must reach.

## Decision

1. **The stack binds `DATABASE_URL` from the `NEON_DATABASE_URL` deploy-environment secret**, following ADR-0028's bind-when-present rule: present and non-empty → `Config.redacted("NEON_DATABASE_URL")` under the binding name `DATABASE_URL`; absent/empty → no binding, chat stays disabled (`503 chat_not_configured`), and no empty `secret_text` is ever written. The binding name (`DATABASE_URL`) stays distinct from the secret name (`NEON_DATABASE_URL`) so the WorkerBindings type and the chat wiring are unchanged.

2. **Staging CI requires it.** ADR-0028's revisit trigger ("the chat routes land and the vendor keys / Sentry become load-bearing in staging: promote the secrets from optional to required") fires for the store: `staging.yml`'s require-secrets guard adds `test -n "$NEON_DATABASE_URL"` and all three deploy workflows (`staging.yml`, `deploy.yml`, `provision.yml`) pass the secret through to the deploy step. Production (`deploy.yml`) stays pass-through-optional until the owner points prod at its own database — an unset secret there degrades exactly as before (chat 503).

3. **The OpenAPI document tells the truth about `/v1/chat`'s failure modes.** The route description now documents 400/401/404/502/503 alongside 200 — including `503 chat_not_configured` (config-disabled) and `502 upstream` (the typed engine error channel). DAST then verifies documented behavior instead of tripping on undocumented statuses; unauthenticated fuzzing gets the documented 401.

## Consequences

- With `NEON_DATABASE_URL` set (it is), the next staging deploy binds the store and `/v1/chat` stops 503-ing at the wiring: unauthenticated calls get 401, authenticated calls run the pipeline. The DAST step goes green without suppressing any check.
- Staging deploys fail fast when the secret is missing, instead of silently shipping a chat-disabled Worker that CI only fails at the fuzz step.
- The database URL travels through the deploy environment as a secret (never committed; Alchemy writes it as `secret_text` on the Worker) — unchanged exposure from the wrangler-era `wrangler secret` practice recorded in ADR-0028.
- `deploy.yml`/`provision.yml` pass `NEON_DATABASE_URL` but do not require it: prod bring-up remains an owner step (ADR-0028 consequence "promote the secrets"), now recorded as required only where the surface is load-bearing.

## Alternatives considered

- **Suppress the schemathesis failure for `/v1/chat`** (e.g. disable the response-status check or exclude the operation): hides the real gap — a chat route that can never work on staging — and grows a suppression every time the surface grows. Rejected.
- **Document only the 503 without binding the secret**: makes the fuzz pass but ships a knowingly broken chat surface on staging, defeating ADR-0034's premise (the harness scores staging answers). Rejected.
- **Add Neon to the stack via `Neon.Branch`** so the deploy tooling provisions the database: ADR-0028 decision 4 defers this (free-tier project limits; no reason to point deploy tooling at the corpus). Rejected for now; binding the existing secret is the minimal move.

## Revisit triggers

- Production bring-up (`deploy.yml`): the owner sets prod's database (likely a separate Neon branch/URL) — then promote `NEON_DATABASE_URL` to a required guard there too.
- Stage isolation (staging vs prod pointing at different Neon branches): rename per-stage secrets in the workflows; the stack file needs no change (it binds whatever `NEON_DATABASE_URL` it is given).
