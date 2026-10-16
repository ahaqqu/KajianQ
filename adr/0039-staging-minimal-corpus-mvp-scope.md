# ADR-0039: The smoke is a behavioural gate on a partial corpus; the full corpus is a milestone of the store sized for it

## Decision

1. **A store carries the smallest corpus that satisfies the gate** unless it is sized for the full one; the full corpus is a milestone of the store that can hold it, not a prerequisite of the smoke.
2. **The smoke's evidence is a behavioural gate on a partial corpus** — refusal correctness, citation validity, and recall by source type — and the change's own description says so plainly rather than implying corpus coverage.
3. **Widening the scope is deliberate and reversible:** one more bounded ingestion pass (ADR-0037) adds a collection, and the store's headroom is checked first, because a store over its capacity fails writes rather than warning.

## Why

The gate scores behaviour, never corpus coverage, so spending money and hours to satisfy a coverage invariant the gate does not read is exactly the waste ADR-0037 exists to prevent. Scoping is cheap to reverse, needs no plan change, and keeps a capacity concern with the store that has it. A partial corpus still exercises the whole path: the questions a store can answer are answered from the collections it holds.

Rejected: loading every collection into a store that cannot hold them, purely to carry data the gate never reads; dropping the approximate-nearest-neighbour indexes as the bring-up retrieval path — a real capacity lever, but it trades a latency property for capacity the scoping already provides, and the index rebuild belongs with the store's sizing work; committing the corpus at a lower embedding precision, which changes the posture the benchmark decided (ADR-0036) and needs its own measurement gate; splitting the corpus across stores, which breaks the one-store premise of the seam.

## Consequences

- Retrieval is exercised against the collections a store holds, so a defect specific to another collection's structure does not surface there.
- Residual recall risk, accepted: a question whose evidence sits in a collection the store does not hold must still be answered or refused correctly, and the smoke's scored set is chosen with that in mind.
- The Golden Set's fabricated-attribution trap targets material absent from every collection the source carries, so it tests "does not fabricate without evidence" rather than a present-but-weak hadith — a curation-gate question, recorded rather than hidden.
- **Revisit when** a store is sized for the full corpus (load it there and retire the scoping), a collection-specific retrieval bug appears (widen the corpus deliberately, checking headroom first), or the index and precision levers become necessary (each needs its own record and measurement gate).
