# ADR-0049: A retrieved verse anchors a bounded neighbourhood read, and a range citation grounds on every address it names

## Decision

1. **A retrieved verse is a second expansion anchor.** When the retrieved set — the fused hits plus ADR-0045's surah-scope chunks — holds a verse, its ordinal neighbours in the same parent join the context: the same deterministic, vendor-free read, on a second anchor.
2. **The anchor is the retrieved child id, not a derived ordinal.** The read derives the parent and the ordinal from the stored row, returns neighbours only and never the anchor, and learns nothing about the domain — no domain term, no citation grammar, no metadata key. `NEIGHBOUR_EXPANSION_RADIUS` and `NEIGHBOUR_EXPANSION_CAP` bound it at the composition root: zero on either disables, and a negative value is a typed config failure, never a silent default.
3. **A range citation grounds only when every address it names is present, the interior included.** A grammar declares the list of addresses a range names, bounded by the surah's own verse count, so a span that bound cannot hold refuses; a grammar that declares no list stays whole and refuses. The display form stays the range as written.
4. **One owner, and the path is on the trace.** One derivation serves the citation gate, the citations frame and the eval alike; added chunks carry their own origin label, a typed event records the anchors read in priority order, and a neighbour already in context is not added twice.

## Why

A draft extended a retrieved verse into a range whose head was never retrieved, and withholding a citation nobody retrieved is the product's first control — so the addresses had to become present, not the rule looser. Keying the read on what is already in context keeps both safety and fluency, the cap makes the widening affordable, and the priority order makes it useful by spending the budget on the best-ranked evidence's neighbourhood.

Rejected: prompt guidance alone, because the behaviour is what the deterministic read now guarantees; re-curating the failing fixture, whose question is answerable, so hiding the range removes the signal rather than the defect; head-first matching, which asserts grounding for an unretrieved verse; any-member matching, the same hole wider; a regex at the comparison site, because splitting is address semantics that only the grammar owning the address can decide; an ordinal-anchored window, which makes a chunk's position a second source of truth silently; reusing the parent-scoped read, which opens at the parent's start rather than the anchor's neighbourhood; an uncapped window, which would become the bulk of a Quran-bearing query's context; a direction-restricted window, when the incidents extend a range in opposite directions; and a paid call to widen recall, when the reference is already stated by the retrieved row — a lookup, not an inference.

## Consequences

- A fully-retrieved range grounds; a fabricated one still refuses — head only, tail only, an impossible address or a fabricated second address all withhold.
- A failure on the neighbour read is fail-closed, uniform with the fused and scope reads; degrading would reproduce the refusal this record removes, behind a successful response.
- The trace contract grows additively, so persisted traces stay readable, and the eval's expansion block keeps its ADR-0045 meaning — the scope path only — because folding the two together would redefine a published metric.
- Context grows on Quran-bearing queries, bounded by the cap; no retrieved verse means no store read, and the two expansions' budgets are independent, their sum being the query's ceiling.
- **Revisit when** the cap truncates a range the draft writes (revisit the ordering before the radius); the approximate search's tie order matters (a second sort key costs the index scan — measure first); a reranker or second channel must decide how it treats expansion chunks (the origin label is the hook); a non-decimal or Arabic-script range is wanted; or the expansion's cost measurably moves per-query cost (the cap is the knob, and the measurement belongs in the spec's cost section).
