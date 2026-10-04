# ADR-0049: A retrieved verse anchors a bounded neighbourhood read, and a range citation grounds on every address it names

## Decision

1. **A retrieved verse is a second expansion anchor.** When the retrieved set —
   the fused hits plus ADR-0045's surah-scope chunks — holds a verse, its
   ordinal neighbours in the same parent join the context: the same
   deterministic, vendor-free read, on a second anchor.
2. **The anchor is the retrieved child id, not a derived ordinal.** The read
   derives parent and `ordinal` from the stored row and orders neighbours by the
   caller's array — the priority order, so the cap truncates the least important
   windows. `NEIGHBOUR_EXPANSION_RADIUS` and `NEIGHBOUR_EXPANSION_CAP` bound the
   expansion at the composition root: `0` on either disables, and a negative
   value is a typed config failure, never a silent default.
3. **A range citation grounds only when every address it names is present, the
   interior included.** `addressesOf` declares that list (`QS. 3:1-2` names
   `QS. 3:1` and `QS. 3:2`; a chain names every number it writes), bounded by the
   surah's own ayah count — a span that bound cannot hold refuses. A spaced
   joiner names the same addresses; a grammar that declares no list (the hadith
   number) stays whole and refuses, and the display form stays the range as
   written.
4. **One owner, and the path is on the trace.** `groundingLabelsFor` serves the
   gate, the citations frame and the eval alike; added chunks carry
   `origin: "verse_neighbours"`, and a typed `neighbour_expansion` event records
   the anchors read in priority order.

## Why

The draft extended a retrieved verse into a range whose head was never retrieved, and withholding a citation nobody retrieved is the product's #1 control — so the addresses had to become present, not the rule looser.

- **Cause-side keeps safety and fluency.** Grounding a fully-retrieved range is fidelity to the stated rule, and the read is keyed on what is already in context.
- **The cap makes the widening affordable; the order makes it useful.** The budget goes to the best-ranked evidence's neighbourhood, and the truncated set follows the run's own retrieval order.
- Rejected: prompt guidance alone — the behaviour is what the deterministic read now guarantees.
- Rejected: re-curating the failing fixture — its question is answerable, so hiding the range removes the signal, not the defect.
- Rejected: head-first matching — a range names what it names, and the head alone asserts grounding for an unretrieved verse.
- Rejected: any-member matching — the same hole, wider: a long range would ground on one retrieved verse.
- Rejected: a comparison-site regex — splitting is address semantics, which only the grammar owning the address can decide.
- Rejected: an ordinal-anchored window — a derived ordinal makes a chunk's position a second source of truth, silently.
- Rejected: reusing the parent-scoped read — it opens at the parent's start, not at the anchor's own neighbourhood.
- Rejected: an uncapped window — it would become the bulk of a Quran-bearing query's context, against the cost posture.
- Rejected: a direction-restricted window — the two incidents extend a range in opposite directions, and priority order handles both.
- Rejected: a paid call to widen recall — the reference is already stated by the retrieved row: a lookup, not an inference.

## Consequences

- **A fully-retrieved range now grounds; a fabricated one still refuses** — head only, tail only, an impossible address or a fabricated second address all withhold, and a single fabricated verse is unchanged.
- **A failure on the neighbour read is fail-closed**, uniform with the fused and scope reads; degrading would reproduce the refusal this record removes, behind a 200 response.
- **The trace contract grows additively** — one event kind — so persisted traces stay readable (ADR-0007); the eval's `expansion` block keeps its ADR-0045 meaning (the **scope** path only), because folding the two together would redefine a published metric.
- **Context grows on Quran-bearing queries**, bounded by the cap; no retrieved verse means no store read, and the two expansions' budgets are independent, their sum being the query's ceiling.
- **Revisit when** the cap truncates a range the draft writes (revisit the ordering, not the radius, first); the ANN search's tie order matters (a second `ORDER BY` key costs the HNSW index scan — measure first); or a reranker or second channel must decide whether it sees neighbour chunks (`origin` is the hook).

## Where it lives

- `packages/kajianq-domain/src/chat-neighbour-expansion.ts` — anchor selection, the radius and cap, dedup, the origin label and the trace detail; `packages/kajianq-domain/src/chat-retriever.ts` runs it after ADR-0045's expansion.
- `packages/kajianq-domain/src/chat-citation-range.ts` and `chat-citation-grammar.ts` — what a Quran range names; `chat-citation-validator.ts`'s `groundingLabelsFor` is the one owner of what grounds a span, read by `apps/api/src/lib/chat-citations.ts` and the eval.
- `packages/infra/src/rag-store-corpus-seam.ts` and the Postgres adapter — the id-anchored read; `packages/contracts/src/trace.ts` — the event variant; the composition root — the two config knobs. Evidence: `packages/kajianq-domain/src/chat-neighbour-expansion.test.ts` and `chat-citation-validator.test.ts` at the gate boundary, with the read's executable contract in the real-Postgres suite.
