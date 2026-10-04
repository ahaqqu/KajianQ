# ADR-0045: Surah-reference scoped expansion — the question's own reference pulls that surah's children into context

## Decision

1. **Retrieve the named surah's children alongside the fused hits, never instead
   of them**: a direct store lookup of that surah's parent document and a bounded
   window of its children, run on the verbatim question rather than a router
   sub-query, with no embedding, no LLM and no dependence on the router's
   phrasing. A retrieved verse is a second anchor (ADR-0049).
2. **Detection is domain logic and lives in the domain pack.** It matches an
   explicit address and a surah name preceded by `surah`/`surat` — canonical,
   article-stripped, space-insensitive compact, elongation-collapsed, or a table
   alias — and never a bare name, because surah names are ordinary words and
   divine names too: the Golden Set's Ar-Rahman question is the trap. An
   address's verse is validated against the surah's own ayah count, so the trace
   never names a verse the surah does not have.
3. **Bound the expansion by an explicit, configurable cap.** `SCOPE_EXPANSION_CAP`
   is a non-negative integer; `0` disables and a malformed value is a typed config
   failure, never a silent default. The window is the parent's stable ordinal
   order — a short surah comes back whole, a long one yields its deterministic
   opening `cap` children — and the read's one-extra-row probe is the truncation
   signal.
4. **Make the path first-class on the trace**: a typed `scope_expansion` event
   (opaque key/value, `returned`, `cap`, `truncated`) and `origin:
"scope_expansion"` on every added chunk ref; a recognised-but-empty scope is
   recorded too, and the label reaches the user-facing Trace frame and the eval.
5. **Keep the engine surface generic — no domain vocabulary crosses into
   `rag-core`**: the routed query's source text, the chunk origin label, the trace
   variant and one store read addressed by an opaque provenance key; the surah
   number, the citation grammar and the name table stay in the domain pack.

## Why

A short, formulaic verse is an unreachable semantic neighbour of a whole-surah meta-question, and the router's paraphrase flipped even the reachable verses in and out of the set — so the reference the user already stated is read, not inferred.

- **Deterministic beats semantic for a reference the user already stated** — reading the named surah's children is a lookup whose result cannot vary between runs.
- **The fix is worth more than the flaky gate**: the defect is a whole-surah question answered with no part of that surah, and fixing the class removes the coin flip with it.
- **Bounded by construction, because context is the cost** — an uncapped expansion of a long surah would blow the assembly budget, which is why the cap is an operator's number and the trace shows what it spent.
- **Traceability is the product boundary here** — a path that adds chunks without leaving a record is the silent machinery the trace exists to prevent.
- Rejected: reference-augmented embeddings — a paid re-ingest with snapshot brackets and a gate revalidation, treating a stated identity as a similarity problem; its general short-verse advantage is a separate, still-open improvement.
- Rejected: a third lexical RRF list — it helps explicit addresses only, and competes with the fused ranks instead of guaranteeing the surah's presence.
- Rejected: stabilizing the gate only — it does not fix recall, and at best makes a real failure deterministic.
- Rejected: bare-name matching (the Ar-Rahman trap), an LLM detector (a paid call where a string match is exact), a multi-surah or verse-centered window (deferred: reads the seam lacks), and re-curating the fixture — its comment forbids hiding the gap.

## Consequences

- **The expansion is reported, not silent**: each scored outcome persists its contribution (`expansion.chunks`, `fusedOnlyRetrievalRecall`) and the Trace frame carries the origin label, so on the questions that name a reference the recall leg is satisfied by construction, and a fused-only figure below the reported one is the report's own statement that the expansion carried the question.
- **The metric is unchanged, and no LLM judge is involved** — `citationValidity` still binds verse-specific requirements.
- **A failure on the expansion read fails the retrieval**: deliberately fail-closed and uniform with the fused reads, because degrading would let a store blip answer a whole-surah question with no part of that surah behind a 200.
- **Cost per scoped query rises by at most the cap in prompt**; no vendor call is added, and an unscoped question pays nothing and issues no read.
- **The trace and frame contracts grow additively**, so persisted traces and older frames still parse; the store seam gained one read that any future adapter must implement.
- **Revisit when** a name spelling no table rule reaches matters (an alias plus a test, not a wider match); the elongation collapse's own false-positive class stops being acceptable-as-is; a comparison question needs both scopes under one budget; a verse-centered window needs a read the seam lacks; Arabic-script names are wanted; or a second channel or reranker must decide how it treats expansion chunks (`origin` is the hook).

## Where it lives

- `packages/kajianq-domain/src/surah-reference.ts` and `surah-names.ts` — the detector and the name table; `chat-scope-expansion.ts` — the bounded read, the cap, the provenance label and the trace detail; `chat-retriever.ts` wires it after fusion and `chat-router.ts` carries the source text.
- `packages/infra/src/rag-store-corpus-seam.ts` and the Postgres adapter — the parent-scoped read; `packages/contracts/src/trace.ts` — the `scope_expansion` variant and `ChunkRef.origin`; the composition root — the cap.
- Evidence: `packages/kajianq-domain/src/chat-scope-expansion.test.ts` (whole-surah expansion, no read for an unscoped question, the cap and `truncated`, dedup, `cap: 0`), `surah-reference.test.ts` (the ayah counts pinned against the committed surah list, the marker traps, and the Golden Set question set that expands), and the contract tests pinning the additive trace and frame.
