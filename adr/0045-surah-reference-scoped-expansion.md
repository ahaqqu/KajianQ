# ADR-0045: A surah reference in the question pulls that surah's children into context

## Decision

1. **The named surah's children are retrieved alongside the fused hits, never instead of them:** a direct store lookup of that surah's parent document and a bounded window of its children, run on the verbatim question rather than on a router sub-query, with no embedding, no model call and no dependence on the router's phrasing. A retrieved verse is a second anchor (ADR-0049).
2. **Detection is domain logic and lives in the domain pack.** It matches an explicit address, or a surah name preceded by a marker word, never a bare name. An address's verse is validated against the surah's own verse count, so the trace never names a verse the surah does not have, and a form carrying no number records the surah alone rather than inventing a verse.
3. **The expansion is bounded by an explicit, configurable cap** — `SCOPE_EXPANSION_CAP`, a non-negative integer where zero disables and a malformed value is a typed config failure rather than a silent default. The window is the parent's stable ordinal order, so a short surah comes back whole and a long one yields its deterministic opening children.
4. **The path is first-class on the trace.** Every added chunk reference carries an origin label, and a typed event records the scope, what was returned, the cap and whether it truncated; a recognised but empty scope is recorded too, and the label reaches the user-facing trace frame and the eval.
5. **The engine surface stays generic.** What crosses into the engine is the routed query's source text, the chunk origin label, the trace variant and one store read addressed by an opaque provenance key; the surah number, the citation grammar and the name table stay in the domain pack.

## Why

A short, formulaic verse is an unreachable semantic neighbour of a whole-surah meta-question, and the router's paraphrase flipped even the reachable verses in and out of the set — so the reference the user already stated is read, not inferred. A bare name is not a reference: almost every surah name is also an ordinary word or a divine name, which is what the marker requirement keeps safe. Deterministic beats semantic for a reference the user already stated, and detecting on the verbatim question means a paraphrase that drops the name still expands. Context is the cost, so the cap is an operator's number and the trace shows what it spent, and a path that adds chunks without leaving a record is the silent machinery the trace exists to prevent.

Rejected: reference-augmented embeddings — a paid re-ingest with snapshot brackets and a gate revalidation, treating a stated identity as a similarity problem; a third lexical list in the rank fusion, which helps explicit addresses only and competes with the fused ranks instead of guaranteeing the surah's presence; stabilizing the failing gate only, which does not fix recall; bare-name matching; a model-based detector, a paid call where a string match is exact; and a multi-surah or verse-centred window, deferred because the read does not exist yet.

## Consequences

- The expansion is reported, not silent: each scored outcome persists its contribution and the trace frame carries the origin label, so on a question that names a reference the recall leg is satisfied by construction.
- A failure on the expansion read fails the retrieval — deliberately fail-closed and uniform with the fused reads, because degrading would let a store blip answer a whole-surah question with no part of that surah behind a successful response.
- Cost per scoped query rises by at most the cap in prompt, no vendor call is added, and an unscoped question pays nothing and issues no read.
- The trace and frame contracts grow additively, so persisted traces and older frames still parse, and the store seam gains one read that every adapter must implement.
- **Revisit when** a name spelling no table rule reaches matters (an alias plus a test, not a wider match); the normalization's elongation collapse produces a false positive that stops being acceptable as it stands (narrowing the collapse reopens the spellings it fixed); a question phrased without a marker word measurably matters (a disambiguation rule that must keep the bare-name trap passing); a comparison question needs both scopes under one budget; a verse-centred window needs a read the seam lacks; or a future embedding re-ingest improves short-verse recall generally (the two are measured together, not assumed to compose).
