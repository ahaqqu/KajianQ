# ADR-0049: A retrieved verse anchors a bounded neighbourhood read, and a range citation grounds on every address it names

## Decision

1. **A retrieved verse is a second expansion anchor.** When the retrieved set —
   the fused hits plus ADR-0045's surah-scope chunks — holds a verse, its
   ordinal neighbours in the same parent join the context: the same
   deterministic, vendor-free read, on a second anchor.
2. **The anchor is the retrieved child id, not a derived ordinal.** The read
   derives parent and `ordinal` from the stored row, returns neighbours only
   (never the anchor), and orders them by the caller's array and then by
   `ordinal`. It learns nothing about Quran — no domain term, no citation
   grammar, no metadata key — and `NEIGHBOUR_EXPANSION_RADIUS`/`NEIGHBOUR_EXPANSION_CAP`
   bound it at the composition root: `0` on either disables, and a negative
   value is a typed config failure, never a silent default.
3. **A range citation grounds only when every address it names is present, the
   interior included.** `addressesOf` declares that list (`QS. 3:1-2` names
   `QS. 3:1` and `QS. 3:2`; a chain names every number it writes), bounded by the
   surah's own ayah count — a span that bound cannot hold refuses. A spaced
   joiner names the same addresses, a newline is not one, and a grammar that
   declares no list (the hadith number) stays whole and refuses: its _spaced_
   draft form is scanned as its head, an explicit exclusion rather than a
   silent one, pinned by `chat-citation-validator.test.ts`, revisitable only by
   declaring an address list for it, while a chunk label with air around the
   joiner is kept whole. The display form stays the range as written.
4. **One owner, and the path is on the trace.** `groundingLabelsFor` serves the
   gate, the citations frame and the eval alike; added chunks carry
   `origin: "verse_neighbours"`, a typed `neighbour_expansion` event records the
   anchors read in priority order, and a neighbour already in context is not
   added twice.

## Why

The draft extended a retrieved verse into a range whose head was never retrieved, and withholding a citation nobody retrieved is the product's first control (`SPECS.md` §2.2) — so the addresses had to become present, not the rule looser.

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
- **The read runs after ADR-0045's surah expansion and before assembly**, and `rrfFuse` breaks equal fusion scores by chunk id so the anchor priority is total; the corpus seam and its Postgres adapter carry the read, `packages/contracts/src/trace.ts` the event variant, the citations frame reads the same one owner, and the two config knobs sit at the composition root.
- **Revisit when** the cap truncates a range the draft writes (revisit the ordering, not the radius, first); the ANN search's tie order matters (a second `ORDER BY` key costs the HNSW index scan — measure first); a reranker or second channel must decide whether it sees neighbour chunks (`origin` is the hook); the hadith number's spaced exclusion above is revisited (declaring an address list for it is a grammar-level change plus a test, one grammar at a time); a third grammar with a list-valued address must declare its own `addressesOf`; non-decimal or Arabic-script ranges are wanted; or the expansion's cost measurably moves per-query cost (`NEIGHBOUR_EXPANSION_CAP` is the knob, and the measurement belongs in `SPECS.md` §5).
