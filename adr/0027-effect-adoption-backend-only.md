# ADR-0027: Effect adopted in engine packages and API only; frontend stays plain TypeScript

## Status

Accepted (2026-09-05). Amends ADR-0021 (pipeline runner: hand-rolled typed seams with a deferred framework revisit trigger). Decision input: a repo-wide migration review (2026-09-05) comparing "Effect everywhere" against "Effect in the backend only".

## Context

The engine's seams are already conceptually Effect-shaped without Effect: `ProviderErrorKind` is a typed error taxonomy that travels via `throw` (so every signature says `Promise<T>`), `RunContext` is an explicit service bag (`config`, `now`, `record`, `defer`), `runPipeline` tears down `defer`red disposers LIFO in a `finally` (a hand-rolled `Scope`), and the SSE adapter is a careful `AsyncIterable` with deferred cost resolution. What the code lacks and now concretely needs:

1. **Typed error channels.** `ProviderError` kinds (`transport`, `rate_limited`, `server`, `bad_request`, `exhausted`) are data, but signatures cannot say so; callers discover failure modes only by reading implementations.
2. **Retry policy.** `FallbackProvider` retries the next candidate on a bare `try/catch` — there is no backoff, no schedule, no per-kind policy.
3. **Interruption.** An aborted HTTP request does not propagate into a running pipeline; for a streaming chat product (client cancels generation) this is a functional gap, not a nicety.
4. **Bounded concurrency.** Ingestion and eval batches are deliberately serial loops; a rate-limit-aware parallel map is upcoming work with no primitive behind it.

ADR-0021 deferred a service-graph framework (cordis) behind a revisit trigger requiring "all of": a second DARS consumer, a config-map-outgrown surface, live wiring introspection, and proof under the Cloudflare Workers runtime. None of those triggers has fired as written. This ADR amends rather than relitigates: the trigger's premise was that no framework need existed. The four needs above are now concrete, and the adoption cost is at its historical minimum — the guarded chat/feedback routes are not mounted yet (`apps/api/src/routes/index.ts`), so the entire migration surface is `packages/` plus an API shell of health/docs routes. Adopting after the chat routes exist would mean rewriting them.

Effect (v3) was chosen over cordis and over more hand-rolling because it is runtime-portable (works under Cloudflare Workers with the already-enabled `nodejs_compat` flag, plus Bun for the off-Workers CLI), domain-neutral (the boundary gate's vendor/domain/DB-client scans are unaffected by the dep name), and delivers exactly the four needs (typed `E`/`R` channels, `Schedule`-based retry, `Scope`/`Layer` lifecycle, `Stream` with interruption).

## Decision

1. **Scope: engine packages and API only.** `effect` (pinned to v3.x — v4 is RC) becomes a dependency of `packages/rag-core`, `packages/infra`, `packages/rag-ingest`, `packages/eval`, and `apps/api`. Seam signatures become `Effect<A, E, R>`; `RunContext` responsibilities map to `Context.Tag` services; `runPipeline` owns a `Scope`; `FallbackProvider` uses `Effect.retry` with per-kind `Schedule`s; SSE deltas become `Stream` with interruption propagation into the provider fetch.
2. **Go/no-go gate before any migration PR.** A spike must prove, under `wrangler dev` and `wrangler deploy --dry-run`: worker bundle size, cold-start latency, and TypeScript 7 (tsgo) typecheck latency on Effect's type machinery under the repo's strict `tsconfig.base.json` (`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`). A cold-start or typecheck regression stops the migration and this ADR is revised. This carries over ADR-0021's "proven under the Workers runtime" condition rather than dropping it.
3. **The HTTP edge stays Hono.** API handlers bridge via `Effect.runPromise`; no `@effect/platform` HTTP server replaces Hono+hono-openapi; the `openapi:check` flow and the OpenAPI 3.1 contract are untouched. `packages/rate` and `packages/hardening` stay plain functions over Hono — low value, high churn to convert.
4. **Valibot stays; Effect Schema is not adopted.** The valibot contracts power validation, OpenAPI generation (`@valibot/to-json-schema` via hono-openapi), and are shared verbatim with the web app. Valibot parse runs inside `Effect.try` at the interop point. One schema vocabulary, repo-wide.
5. **The frontend stays plain TypeScript.** React 19 + TanStack Query/Router + valibot is unchanged. Grounds: the `size-limit` gate allows a single 200 KB-gzip bundle with ~75 KB headroom, which the unbuilt chat UI (markdown, streaming trace panel) will consume — the whole `effect` package measures ~293 KB gzip and even tree-shaken usage costs tens of KB (the repo already declined Sentry Session Replay at ~40 KB for exactly this budget); the current UI is ~520 lines with one query, leaving Effect nothing to manage that TanStack Query does not already own better; and the `@effect/rpc` unification path would regress the hono-openapi/OpenAPI toolchain. The API contract between web and API (HTTP/JSON + valibot schemas) is the only interface, and it does not change.
6. **Traceability is unchanged.** Effect's telemetry/OTel is ops observability and is not adopted; the product `Trace` contract (`TraceEvent` valibot schemas persisted via `RagStore.insertAnswerTrace`) remains the single user-facing trace mechanism. `RunContext.record` semantics carry over to the service equivalent.

## Consequences

- Signature churn across ~97 backend source files and 37 test files, executed incrementally (rag-core → infra → api → rag-ingest/eval), one PR per phase, all CI gates green per PR. Tests keep vitest + fast-check; programs run under test via `Effect.runPromise`; coverage thresholds (80/70) unchanged.
- `packages/` is the template-sync merge path (ADR-0024): forks inherit Effect in the engine. Accepted — it makes a future DARS extraction (ADR-0005) more coherent, and forks consume `packages/` as a unit either way.
- Engine purity holds structurally: `effect` is domain- and vendor-neutral, so the boundary gate needs no rule changes and no exemptions; the `truth` gate is satisfied by the migration PRs' importers.
- The agentic-limits gate (≤300 lines, ≤5 direct imports per file) applies to Effect-style files like any other; `Effect.gen` pipelines are expected to fit, with file splits preferred over exemptions.
- Learning curve is a real cost: every contributor to engine packages needs Effect fluency. Mitigated by the seam-first architecture — the API edge, frontend, and domain pack stay readable without it.
- ADR-0021's revisit trigger is satisfied *for Effect specifically* by this ADR (the second-consumer and introspection conditions are waived as no longer relevant to the decision; the Workers-proof condition is retained as the §2 gate). Adoption of any *further* framework layer (`@effect/platform` server, `@effect/rpc`) still requires its own ADR.

## Revisit triggers

- The §2 spike fails its gate (cold-start, bundle, or tsgo typecheck regression) → migration halts, ADR revised.
- Effect v4 leaves RC: evaluate the upgrade as a normal dependency bump, not a re-decision.
- A second DARS consumer or a forking project rejects Effect: the seams remain HTTP/JSON + valibot at every package boundary, so a fork can swap the engine's internals without touching `apps/` contracts.
- The frontend ships the chat UI and develops a demonstrated need Effect uniquely solves (e.g., complex client-side stream orchestration) with measured bundle headroom: revisit decision 5 with a new ADR.
