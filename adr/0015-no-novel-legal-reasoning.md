# ADR-0015: KajianQ presents classical reasoning; it never performs it

## Decision

The generator may explain, compare and contextualize reasoning **found in retrieved sources** — a scholar's stated legal cause, a madzhab disagreement, corroboration between chains or collections, a principle's documented application. A principle is presented as the sources use it, from the human-verified principle index, never as the model's own generalization of a maxim to a case the sources do not cover.

The generator never derives a ruling absent from retrieved evidence, never resolves a madzhab disagreement, and never upgrades a grade beyond the evidence. Insufficient evidence produces the refusal statement **even when a confident synthesis is available**: a fluent guess is a defect, not a partial success. Gap detection in the iterative mode distinguishes "more evidence exists" from "no classical source retrieved addresses this", and a gap is never closed by synthesis.

The refusal is for a fact the evidence does not carry, not for a word it does not print. A question that uses its own term or name for a practice the evidence describes under another name is answered from that evidence — the question's own term is not outside knowledge. A request to compare positions, or for the most excellent among them, is answered from what the evidence states about those things: the absence of an explicit ranking is not an absent fact, and no ranking is invented. A demanded fact the evidence does not state is still refused.

## Why

The product objective is answers with wisdom, and the same capability invites a drift: a strong generator holding principles and rulings in one prompt can synthesize a plausible **new** ruling — performing the reasoning the product's authority forbids. For a product whose authority rests on strict sourcing, machine-derived rulings are the most damaging failure mode available: confident, well-written and uncitable. Because much of the implementation is done by agents instructed to answer fully, that drift is the default failure direction unless the boundary is frozen. The mirror-image failure is a generator that declines evidence it was given because the question's wording, or its request for a ranking, does not match the evidence's wording: the user asked for that evidence, and withholding it is a defect the same boundary creates.

Rejected: permitting guided synthesis with disclaimers — a machine performing ijtihad under a disclaimer is still a machine issuing rulings, the disclaimer does not survive screenshot-sharing, and the practice voids the promise that every claim can be verified against its source; refusing all why and analogy questions — classical kitab carry that reasoning as text, and retrieving it is the product's differentiator, fully inside sourcing discipline.

## Consequences

- The generator prompt carries explicit no-synthesis rules, and the reviewer checks "no claim beyond retrieved evidence" alongside citation validity and faithfulness.
- The prompt states the other half of the boundary too: evidence that answers the asked fact is answered under the question's own term, and a comparison is presented from what the evidence states rather than refused for lacking a ranking.
- The Golden Set carries synthesized-ruling traps, including a novel-analogy bait, and a cross-madzhab answer case the staged smoke always covers.
- Refusals are recorded with the stage that stopped the answer, so they are tunable rather than opaque.
- The wisdom the product delivers is the scholars'; the system finds it, contextualizes it, and admits the gap.
