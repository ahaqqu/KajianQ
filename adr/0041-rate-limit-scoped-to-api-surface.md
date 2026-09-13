# ADR-0041: The per-IP rate limiter meters the /v1 API surface only — assets and doc routes are unmetered

## Status

Accepted (2026-09-13).

Tickets: none (owner decision in the #150 e2e follow-up discussion: "rate limit should be for API only. no rate limit for static assets").

## Context

The per-IP limiter (120/min, `packages/rate`, Durable Object in production) has been registered on `api.use("*")` since the template import (PR #36, `feat(3): monorepo foundation`) — the only justification on record is the `apps/api/src/index.ts` comment lumping it with CSP, CORS, correlation-id, and the typed error handler as things that "apply to the SPA as well". No ADR ever chose asset metering deliberately.

It is not merely unnecessary but mildly harmful:

- **It steals budget from real traffic.** Assets and `/v1` calls share one per-IP bucket, so a page reload (~15 asset requests) consumes the same budget as chat calls — a real false-positive class for NAT'd offices and mobile networks, where many users share one `CF-Connecting-IP`.
- **It pays per asset.** Every asset request performs a Durable Object RPC (key hash + check) just to be counted, on the app's hottest path.
- **It 429s the e2e suite for no product reason.** In e2e every `/v1/*` call is intercepted by fixtures and never reaches the worker — the only traffic that counts is browser asset loads, which multiplied across scenarios and flaked suites (the recurring rate-limiter failures recorded in `playwright.config.ts` and SPECS §2). A bypass credential cannot fix this: browser-initiated asset fetches (`<script>`, CSS, fonts) cannot carry headers or a JWT, so any token-based exemption misses exactly the requests that cause the 429s.
- **It defends nothing.** The abuse surface the limiter exists for is API abuse (chat spend per ADR-0009 cost discipline, auth minting per ADR-0017). Static assets are served by Cloudflare's edge from the ASSETS binding; flooding them costs no LLM money, no database work, and no Worker CPU worth speaking of, and rate-limiting assets does not protect `/v1` from an attacker who simply targets `/v1` directly.

## Decision

1. **The limiter meters only `/v1/*`.** `applyMiddleware` registers the rate-limit middleware on `api.use("/v1/*")` after the shared context middleware; keying (`ip:${CF-Connecting-IP}`), the 120/min default, the backend resolution (Durable Object binding, in-memory fallback), and the test seam (`opts.limiter`/`opts.limit`) are unchanged. Static assets (the `*` ASSETS catch-all) and the developer doc routes (`/openapi.json`, `/docs`) flow through unmetered. Security headers, CORS, correlation-id, and the typed error handler continue to apply to every response, including assets — that part of the shared-stack design was correct and stays.

2. **Bypass tokens for harness traffic, accepted and implemented.** A signature-verified bypass token exempts a request from `/v1` metering — for harnesses that must exceed the per-IP budget itself (schemathesis fuzz, ZAP, load tests) — without touching the 120/min default for real clients:
   - **Ed25519 JWT over pure WebCrypto** (`packages/rate/src/bypass.ts`: `mintBypassToken`/`verifyBypassToken`) — no new dependency, identical code in the Workers runtime, Bun, and Node.
   - **The public key lives in code** (`apps/api/src/lib/rate-bypass.ts`, base64 raw): it can mint nothing, so committing it creates no surface. The matching **private key lives only where minting is allowed**: the owner's `.env` (`RATE_BYPASS_PRIVATE_KEY`, never committed — `.env` is gitignored) and the GitHub Actions secret of the same name. Rotate = regenerate the pair, commit the new public key, re-supply the secret.
   - **Purpose-locked and expiry-gated**: the token carries `purpose: "rate-bypass"` (verification refuses anything else outright), a required `sub` subject, and a short `exp` (mint default 1 h). The bypass skips metering only — it is never a session credential, and guarded routes still enforce their own auth. A dedicated `X-Rate-Bypass` header (not `Authorization`) keeps that distinction visible on the wire.
   - **Verification never throws**: a missing, malformed, expired, or wrong-key token degrades to ordinary metering and logs the reason (`rate.bypass_rejected`) on the request context; a valid one logs `rate.bypass` with the subject — bypassed traffic stays observable (traceability guardrail).
   - **Minting**: `bun run rate:bypass [--ttl-seconds] [--sub]` (Bun auto-loads `.env` locally); the staging workflow's schemathesis step mints a token from the secret and sends it as the bypass header. ZAP stays metered for now (its action interface makes header injection unreliable; the baseline scan fits the budget).
   - **Tests**: the rate package pins the mint/verify contract (round-trip, wrong key, expiry, purpose-locked, garbage-fails-closed); the API middleware tests pin exemption on an exhausted budget, garbage-degrades-to-429, and that the committed public key is a well-formed Ed25519 raw key.

3. **An env-level "disable rate limiting" flag is rejected** — it silently stops staging from exercising the real limiter and is exactly the configuration that drifts into production.

## Consequences

- The 429 contract is unchanged where it was documented: `/v1/health` (and every other `/v1` route) still answers `429 rate_limited` when a client exhausts its window. Non-`/v1` paths are now simply never 429 — which the OpenAPI never claimed they would be.
- The e2e 429 flake class disappears at the root: suites no longer consume the dev worker's budget on asset loads. The playwright `serviceWorkers: "block"` decision stays (SW mechanics are pinned by unit coverage, thermo-review C2), but its rate-limiter rationale is retired.
- A shared-IP user's page reloads no longer erode their chat budget.
- Bypass tokens are verifiable in every environment, including production, because the public key is code — the trust anchor is the private key, which never leaves the minting environments. Leaking `RATE_BYPASS_PRIVATE_KEY` therefore weakens prod metering too; the secret is treated with API-key-grade care (GitHub Actions secret, gitignored `.env`), and rotation is a two-file change.
- Residual risk accepted: `/openapi.json` and `/docs` are unmetered Worker invocations. They are read-only, cheap, developer-facing, and sit behind Cloudflare's own edge protection; metering them buys nothing the limiter was ever for.

## Alternatives considered

- **Keep `*` metering and add a signature-verified bypass header as the primary fix** — rejected: it cannot attach headers to the asset fetches that cause the 429s, and it would have kept the harmful asset metering. The bypass exists instead as a secondary mechanism scoped to the (now `/v1`-only) metered surface, per Decision 2.
- **Set `RATE_LIMITER` unbound / raise the limit in staging** — an env-shaped kill switch; rejected (Decision 3): config drift into production disables the real defense.
- **Exempt same-origin GETs by `Sec-Fetch-*` headers** — heuristics on client-controlled headers; weaker and harder to reason about than an honest path prefix.
