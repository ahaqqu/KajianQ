# ADR-0018: AssembledContext carries structured turns and the routed query

## Status

Accepted (2026-08-23). Bounds the `Generator`/`Assembler`/`Reviewer` interfaces in `packages/rag-core` before #5 implements the `Generator` and #6 implements the `Retriever`. Supersedable by a future ADR if streaming or multi-turn chat demands a richer turn shape.

## Context

The foundation PR (#36) shipped the five pipeline interfaces in `packages/rag-core/src/pipeline.ts`. A thermos review flagged two shapes that would force breaking changes once #5/#6 implement against them:

1. **`AssembledContext.prompt: string`** — the Assembler handed the Generator a pre-rendered string. The Generator could not re-template, stream a preamble, or apply reviewer-driven reformatting without re-parsing the string. For a traceable, pluggable system this is unusually lossy: the Assembler owns context selection, but the Generator must own the final prompt to the `Provider` (it branches the system prompt by `intent`, applies the citation discipline from `filters`, and is bounded by ADR-0015's no-synthesis rules). A frozen string at the seam makes all of that a re-parse.

2. **`Generator.generate(context)` took no `Query`/`RoutedQuery`** — by the time the pipeline reached the Generator, the Router's `intent`, `subQueries`, and `filters` were gone; only the rendered `prompt` survived. `Reviewer.review(answer, context)` had the same blindness. If #5 had implemented against that shape, either `AssembledContext` would grow a `query` field (non-breaking) or the `Generator` signature would change to `generate(query, context)` (a breaking change to a just-shipped interface).

3. **`RoutedQuery.filters` as `Record<string, string | readonly string[]>`** erased the domain pack's typed `KajianQFilters` (`{ madzhab?, grade?, textLayer? }`). Building a `Query` from `KajianQFilters` required spreading a typed object into an open string map (lossy), and a Retriever reading filters back got strings it had to re-cast to `Madzhab`/`Grade`. The "filters are opaque to the engine" intent was right; the shape was not — it made the domain pack's types advisory only.

The spec (`kajianq-dars-spec.md` §6, §9) and ADR-0015 together prescribe: the Assembler orders Principles first then evidence; the Generator applies a strict-grounding system prompt, branches by intent, and refuses on insufficient evidence; the Reviewer cross-checks "no claim beyond retrieved evidence." All of these need the Generator to see the routed query, not just a frozen prompt.

## Decision

Reshape the `rag-core` pipeline interfaces, in one non-breaking-for-callers change (no implementation exists yet):

1. **`AssembledContext` carries structured `Turn[]`, not a `prompt: string`.** A `Turn` is `{ role: string; content: string }` — minimal and generic. The Assembler owns context *selection and ordering* (Principles first, then evidence); the Generator owns final prompt assembly to the `Provider`. The engine treats `role` as opaque — the domain pack names the roles its prompt templates use.

2. **`AssembledContext` carries the `RoutedQuery`.** `query: RoutedQuery<TFilters>` threads `intent`, `subQueries`, and `filters` through to the Generator and Reviewer, so the system-prompt branch and citation discipline have typed access without re-parsing.

3. **`Query`, `RoutedQuery`, `AssembledContext`, and the five stage interfaces are generic over `TFilters`.** `Query<TFilters extends Record<string, unknown> = DefaultFilters>` defaults to the open string map (`DefaultFilters = Record<string, string | readonly string[]>`) for domain-agnostic callers, so the engine stays generic. The domain pack instantiates `Query<KajianQFilters>` and the Retriever gets typed filter access — no string re-casts at the boundary.

The `Generator.generate(context)` signature is unchanged (it still takes `AssembledContext`); the reshape is additive because no code implements these interfaces yet.

## Rationale

1. **The Generator owns the prompt; the Assembler owns the context.** A frozen string at the seam inverts this — the Assembler becomes the prompt renderer and the Generator becomes a forwarder. Structured turns keep the separation that the pluggable principle (AGENTS.md §1.1) and ADR-0015 both require.

2. **Threading the routed query prevents a breaking change later.** Without `query` on `AssembledContext`, #5's Generator would need the intent/filters and would either grow the type (a second construction site) or change its signature. Carrying it now is the one-line change that the review flagged as cheap-today, expensive-after-#6.

3. **`TFilters` keeps the domain boundary intact without erasing types.** The engine stays domain-agnostic (it never names `Madzhab`/`Grade`); the domain pack gets typed filters that survive the boundary. This is the pluggable principle's "parameterize the concept instead" applied to the filter shape.

4. **`Turn` is minimal on purpose.** A richer messages shape (tool calls, multimodal parts) can grow later without breaking callers; starting with `{ role, content }` is the smallest shape that lets the Generator own assembly. Streaming and multi-turn chat may amend this ADR.

## Consequences

- **#5** implements `Generator` against `AssembledContext<TFilters>`: it reads `context.query.intent` for the system-prompt branch, sends `context.turns` to the `Provider`, and records tokens/latency/cost into the `Trace` (ADR-0007).
- **#6** implements `Retriever` against `RoutedQuery<TFilters>`: it reads typed filters (`RoutedQuery<KajianQFilters>.filters.madzhab`) without re-casting.
- **#7** (Assembler) produces the ordered `Turn[]` — Principles first, then evidence — and returns `AssembledContext` with the routed query attached.
- The `kajianq-domain` pack instantiates `Query<KajianQFilters>` / `RoutedQuery<KajianQFilters>` at the product boundary; the engine never imports that type.
- `Turn.role` being a string (not an enum) is deliberate: the engine does not name roles. If a shared role vocabulary becomes necessary, it lives in `kajianq-domain`, not `rag-core`.

## Alternatives considered

1. **Keep `prompt: string` and add `query` to `AssembledContext`.** Rejected — leaves the Generator unable to re-template or stream a preamble, and ADR-0015's reviewer-driven reformatting still requires re-parsing. The stringly-typed prompt is the core smell.

2. **Change `Generator.generate(context)` to `generate(query, context)`.** Rejected — a breaking signature change to a just-shipped interface, and unnecessary because `query` can ride on `AssembledContext` without changing the signature. Carrying `query` on the context is additive.

3. **Type `filters` as `unknown` at the engine boundary.** Rejected — loses the default shape for domain-agnostic callers and forces every caller to cast. The `TFilters` generic with a `DefaultFilters` default keeps the engine generic and the domain pack typed.