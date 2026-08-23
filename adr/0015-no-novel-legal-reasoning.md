# ADR-0015: No novel legal reasoning — KajianQ presents classical reasoning, never performs it

## Status

Accepted (2026-08-23). Bounds the Generator, Smart Router #14–#15, Principle Index #16, and Deep Think #25. Golden Set #20/#31 carry the traps that enforce it.

## Context

The product objective is answers with wisdom and knowledge, not text search: users ask why-questions, analogy questions, and hard cases. The Smart Router, Principle Index, and Deep Think exist to serve exactly that. The same capability invites a drift: a strong generator (1M-context class) holding Principles + rulings in one prompt can synthesize a plausible *new* ruling — performing de facto qiyas or ijtihad that no classical scholar ever stated. For a product whose authority rests on strict sourcing ("never issue personal fatwa" is hard boundary #1, spec §1.5), machine-derived rulings are the most damaging failure mode available: confident, well-written, and uncitable. Because most implementation is done by AI agents instructed to "answer fully," this drift is the default failure direction unless the boundary is frozen as a decision.

## Decision

KajianQ **surfaces classical reasoning; it does not perform legal reasoning.** Concretely:

- The Generator may explain, compare, and contextualize reasoning *found in retrieved sources* — ta'lil (the legal cause a scholar states), madzhab disagreements, corroboration between chains or collections, a Principle's documented application.
- Principles are presented as the documented lens: the answer names the Principle and its role *as the sources use it*, from the human-verified Principle Index — never the model's own generalization of a maxim to a case the sources do not cover.
- The Generator never derives a ruling absent from retrieved evidence, never resolves a madzhab disagreement (it presents, neutrally), and never upgrades a grade beyond retrieved evidence (carried from spec §9.5).
- Insufficient evidence produces the refusal statement — *even when a confident synthesis is available*. A fluent guess is a defect, not a partial success.
- Deep Think's gap detection distinguishes "more evidence exists → re-retrieve" from "no classical source retrieved addresses this → say so." A gap is never closed by synthesis.

## Alternatives considered

1. **Permit guided synthesis with disclaimers** — rejected. A machine performing ijtihad under a disclaimer is still a machine issuing rulings; the disclaimer does not survive screenshot-sharing, and the practice voids the "verify every claim yourself" promise that the citation discipline exists to keep.
2. **Refuse all why/analogy questions** — rejected. Classical kitab carry extensive ta'lil and applied qiyas *as text*; retrieving and explaining it is the Principle-aware differentiator (spec §1.4) and stays fully inside sourcing discipline.

## Consequences

- The Generator system prompt gains explicit no-synthesis rules; the cross-vendor Reviewer checks "no claim beyond retrieved evidence" alongside citation validity and faithfulness.
- Golden Set gains synthesized-ruling traps: questions where retrieval is *almost* sufficient, where the correct behavior is sources + gap statement, including at least one novel-qiyas bait question. Added to #20's trap coverage.
- The Trace records refusal events with which stage stopped the answer (no evidence retrieved vs. evidence contradicts the premise), so refusals are tunable rather than opaque.
- This ADR bounds the "wisdom" promise explicitly: the wisdom is the scholars'; the system's job is to find it, contextualize it, and admit the gap.
