# ADR-0021: Pipeline runner owns the run scope, run config, and trace assembly

## Status

Accepted (2026-08-26). Records the composition decision for the DARS engine and amends ADR-0018 (stage method signatures) and ADR-0007 (trace collection point). Ticket #75.

## Context

DARS's two design principles — *pluggable by configuration* and *traceable by design* — are close in shape to the plugin meta-framework `cordis` (vendored by the DeepSeek Harness as `@deepseek-ai/cordis`): a service/plugin graph composed from config layers, with an event bus and an introspectable effect tree. The resemblance is real but at the *philosophy* level, not the *domain* level: cordis composes an agent harness; DARS composes a RAG pipeline.

Two constraints argue against adopting cordis the framework today:

1. **ADR-0005's anti-platform caution** — reusability is enforced by package boundaries, "not by building a platform prematurely." DARS has exactly one consumer. Cordis is a full runtime (fibers, isolation scopes, intercept trees, effect metadata), and its traceability primitives (`internal/dispatch`, `getEffects()`) describe *live wiring*, not the persisted per-answer `answer_traces` the product requires — that typed, versioned contract still has to be built either way.
2. **The engine's typed-seam promise** — AGENTS.md §1.1 promises *typed interfaces in `rag-core`*; cordis keys services by string with types via module augmentation, which weakens the compile-time boundary the boundary-lint relies on.

So we adopt cordis's *three ideas* into the existing hand-rolled typed seams, and defer the framework behind a revisit trigger.

## Decision

1. **Typed dispatch.** A `runPipeline(stages, query, config)` in `packages/rag-core` walks Router → Retriever → Assembler → Generator → Reviewer, emits the deterministic stage-boundary `TraceEvent`s (`intent`, `subquery`, `retrieval`, `assembly`) from stage results, and validates + assembles the final `Trace` in one place. Stages append what the runner cannot observe (`llm_call`, `refusal`, `review`) through the run's sink.
2. **Per-run config isolation.** A `RunConfig<TFilters>` (opaque per-stage model ids + filters; no vendor names) is threaded to every stage through a `RunContext` — a plain per-request config object, the hand-rolled equivalent of cordis's `isolate()`.
3. **Lifecycle/disposal.** Each stage interface gains an optional `dispose?()`; the runner provides a per-run `defer()` scope torn down LIFO on completion *and* on failure.

This amends ADR-0018: stage methods gain a `run: RunContext` parameter, and `Generator`/`Reviewer` now return a `Draft` (`{ text }`) instead of `Answer` — the runner owns the final `Trace`. `Answer` remains the runner's output shape.

## Consequences

- `#45` lands with this decision: `TraceEvent` becomes a strict discriminated union keyed on `kind` with typed `detail`, so the runner's emitted events are validated by `parseTrace` before returning.
- `#5` (Provider) and `#10` (Chat pipeline) build against `runPipeline` and `RunContext`; the runner owns the cost-recording seam, so an untraced LLM call is a compile-time-shaped gap, not an ad-hoc one.
- `dispose?()` + `defer()` give stages and Providers a deterministic teardown path (HTTP client handles, per-run buffers).

## Revisit trigger

Adopt cordis (core only) when **all** of: a second DARS consumer appears (the ADR-0005 trigger), the stage/Provider surface outgrows a config map, live wiring introspection is needed beyond persisted traces, **and** `@deepseek-ai/cordis` core is proven to run under the Cloudflare Workers runtime with the boundary lint re-specified against a registry model. Until then, hand-rolled typed seams.
