# ADR-0027: Effect adopted in engine packages and API only; frontend stays plain TypeScript

## Status

Accepted (2026-09-05). Amends ADR-0021 (pipeline runner: hand-rolled typed seams with a deferred framework revisit trigger). Decision input: a repo-wide migration review (2026-09-05) comparing "Effect everywhere" against "Effect in the backend only". The §2 Workers gate passed on 2026-09-05 (Appendix A), with one packaging amendment (Effect lives in the engine packages; `apps/api` bridges via `@app/rag-core` re-exports).

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

## Appendix A — §2 gate executed (2026-09-05): PASSED, with one packaging amendment

The go/no-go spike ran against the Workers runtime as required. Artifacts: `packages/rag-core/src/effect-spike.ts` + its test — one program covering the four needs (typed `Data.TaggedError` channel, `Effect.retry` over an exponential `Schedule`, a `Context.Tag` service provided via `Layer`, a `Stream` built from a `ReadableStream` with interruption-capable consumption) plus the valibot `Effect.try` interop point, pinned to `effect@3.22.1` (latest v3.x; v4 remains RC), typechecked under the repo's strict base tsconfig and run under vitest/bun via `Effect.runPromise`.

**Gate measurements** (worker entry `apps/api/src/index.ts` with the spike module in its import graph; baseline = `main` without Effect; wrangler 4.123.0, `--dry-run --outdir` for bundle size, local workerd `wrangler dev` + timed `/v1/health` for cold start, `tsc -p apps/api/tsconfig.json --noEmit` ×3 for tsgo):

| Gate | Baseline | With Effect v3 | Verdict |
| --- | --- | --- | --- |
| tsgo typecheck latency (apps/api) | 1.02–1.23 s | 1.09–1.34 s | **pass** — no regression |
| Cold start (first request) | 30 ms | 21 ms | **pass** — no regression |
| Steady-state request | ~4 ms | ~4–5 ms | **pass** |
| Worker bundle | 2567 KiB / 483 KiB gzip | 3584 KiB / 677 KiB gzip | **pass** — recorded; see note |

Notes:

- **Bundle delta is larger than the §5 estimate.** The spike's tree-shaken usage costs ~+194 KiB gzip under esbuild (wrangler's bundler), not "tens of KB". The backend has no size-limit gate (the 200 KB gate covers the web bundle only, unchanged at 125.22 kB) and the Workers paid-tier limit is 10 MB gzip, so this is not a gate failure — but the estimate in decision 5's rationale was optimistic for the backend. The production deploy path bundles with rolldown (alchemy, ADR-0028), which tree-shakes better than esbuild; the esbuild figure is an upper bound until the first migrated `alchemy deploy`.
- **Packaging amendment to decision 1 (letter only).** `effect@3` must **not** be declared in `apps/api`'s package.json: Bun resolves alchemy's `effect >= 4.0.0-rc.112` peer dependency to apps/api's declaration, hijacking the deploy tooling onto v3 (observed: one alchemy store instance re-linked to v3, and `alchemy.run.ts` fails to typecheck against v3 — alchemy's API is v4-shaped). Effect v3 is therefore a dependency of the engine packages (`rag-core`, `infra`, `rag-ingest`, `eval`) only; both versions coexist in Bun's store with correct per-package resolution. `apps/api` handlers still bridge via `Effect.runPromise` (decision 3 unchanged), importing it through `@app/rag-core`'s re-exports rather than a direct `effect` dependency. Every substantive goal of decision 1 is unaffected; only the dependency edge moves.
- **Gate mechanics follow ADR-0028, not the wrangler.toml-era wording.** wrangler was used here purely as the measurement harness (the §2 text predates ADR-0028); production bundling/deploy is alchemy's.
- Verdict: **the migration proceeds** (phases: rag-core → infra → api → rag-ingest/eval, one PR each). The spike module stays as a tested reference for the four Effect patterns the migration standardizes on; it is deleted only if a revisit trigger fires.
