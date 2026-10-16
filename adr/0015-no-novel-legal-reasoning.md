# ADR-0015: KajianQ presents classical reasoning; it never performs it

## Decision

The generator may explain, compare and contextualize reasoning **found in retrieved sources** — a scholar's stated legal cause, a madzhab disagreement, corroboration between chains or collections, a principle's documented application. A principle is presented as the sources use it, from the human-verified principle index, never as the model's own generalization of a maxim to a case the sources do not cover.

The generator never derives a ruling absent from retrieved evidence, never resolves a madzhab disagreement, and never upgrades a grade beyond the evidence. Insufficient evidence produces the refusal statement **even when a confident synthesis is available**: a fluent guess is a defect, not a partial success. Gap detection in the iterative mode distinguishes "more evidence exists" from "no classical source retrieved addresses this", and a gap is never closed by synthesis.

## Why

The product objective is answers with wisdom, and the same capability invites a drift: a strong generator holding principles and rulings in one prompt can synthesize a plausible **new** ruling — performing the reasoning the product's authority forbids. For a product whose authority rests on strict sourcing, machine-derived rulings are the most damaging failure mode available: confident, well-written and uncitable. Because much of the implementation is done by agents instructed to answer fully, that drift is the default failure direction unless the boundary is frozen.

Rejected: permitting guided synthesis with disclaimers — a machine performing ijtihad under a disclaimer is still a machine issuing rulings, the disclaimer does not survive screenshot-sharing, and the practice voids the promise that every claim can be verified against its source; refusing all why and analogy questions — classical kitab carry that reasoning as text, and retrieving it is the product's differentiator, fully inside sourcing discipline.

## Consequences

- The generator prompt carries explicit no-synthesis rules, and the reviewer checks "no claim beyond retrieved evidence" alongside citation validity and faithfulness.
- The Golden Set carries synthesized-ruling traps, including a novel-analogy bait.
- Refusals are recorded with the stage that stopped the answer, so they are tunable rather than opaque.
- The wisdom the product delivers is the scholars'; the system finds it, contextualizes it, and admits the gap.
