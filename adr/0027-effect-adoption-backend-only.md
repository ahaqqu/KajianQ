# ADR-0027: Effect in the engine packages and the API only; the HTTP edge and the frontend stay plain

## Decision

1. **Scope: the engine packages and the API.** `effect` is the typed runtime of `packages/rag-core`, `packages/infra`, `packages/rag-ingest`, `packages/eval` and `apps/api`. Seam signatures carry their failure and requirement channels (`Effect<A, E, R>`), `RunContext`'s responsibilities become Effect services, the runner owns each run's `Scope`, provider fallback retries through per-kind `Schedule`s, and SSE deltas are a `Stream` whose interruption reaches the provider fetch. `apps/api` declares no direct `effect` dependency; it reaches the runtime through `@app/rag-core`'s re-exports.
2. **One Effect version, workspace-wide.** Every consumer resolves the single pinned version through the root manifest's override — engine, API and tooling import one Effect line, and a second copy in the tree is a defect, not a configuration choice.
3. **The HTTP edge stays Hono.** Handlers bridge through `Effect.runPromise`; no Effect HTTP server replaces Hono + hono-openapi, and the OpenAPI contract is untouched.
4. **Valibot stays the one schema vocabulary.** Effect Schema is not adopted; valibot parsing runs at the interop point.
5. **The frontend stays plain TypeScript** — React + TanStack Query + valibot, with the HTTP/JSON contract and its valibot schemas as the only interface between web and API.
6. **Traceability is unchanged.** Effect's telemetry is ops observability and is not adopted; the product `Trace` contract remains the single user-facing trace mechanism.
7. **The Effect surface is closed.** In: the persistence seams `RagStore` and `ObjectStore` (`Effect<A, StoreError, R>`), with the closed `StoreError` taxonomy owned by the engine, and the contract suite covering them. Out, each with its reopen condition: `packages/contracts` (never — a schema vocabulary is not an effect runtime); `packages/rate`, `packages/hardening`, the Hono edge, and migrations with their CLI (only if one of them acquires retry or interruption semantics, via a new ADR). The deploy path stays with its own toolchain, outside the engine.

## Why

The seams were already Effect-shaped by hand — a typed error taxonomy travelling through `throw`, a service bag standing in for `Context`, a `finally` standing in for `Scope`, an `AsyncIterable` standing in for `Stream` — and four gaps had become concrete:

1. Signatures could not state their failure modes; callers learned them by reading implementations.
2. Provider fallback retried with no backoff and no per-kind policy.
3. An aborted request did not interrupt a running pipeline — a functional gap for a streaming product.
4. Batch ingestion and eval had no bounded-concurrency primitive.

Effect was chosen over adopting a service-graph framework (ADR-0021 had deferred cordis) or more hand-rolling because it delivered exactly those four needs, ran wherever the engine had to run, and stayed domain- and vendor-neutral — the boundary gate needs no exemption for it. Adopting while the guarded routes were still unmounted kept the migration surface to `packages/` plus an API shell, so no live route had to be rewritten.

The cost accepted: engine contributors need Effect fluency, and the engine's idioms no longer read as plain TypeScript. The seam-first architecture keeps the API edge, the frontend and the domain pack readable without it, and every package boundary stays HTTP/JSON + valibot.

## Consequences

- Signature churn lands behind the existing seams, phase by phase, with every gate green at each step.
- Forks inherit Effect in the engine, because `packages/` is the shared-engine merge path — accepted, and it makes a future DARS extraction (ADR-0005) more coherent.
- Any further framework layer (`@effect/platform` server, `@effect/rpc`) needs its own ADR.
- **Revisit when** a second DARS consumer or a fork rejects Effect (the boundaries are HTTP/JSON + valibot, so the engine's internals can be swapped without touching `apps/`), or the frontend develops a need Effect uniquely solves, with measured bundle headroom.
