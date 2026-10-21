# ADR-0057: The not-a-fatwa disclaimer is the rule's one canonical close

## Decision

The canonical close accompanies every answer the Product rules decorate — a pure refusal is exempt — and is that answer's final paragraph, written once by the rule; a unit is deleted only when its normalised token sequence equals one of the rule's disclaimer templates, a closed set, so any unit carrying another token is preserved byte-for-byte beside the close (a paraphrase outside the set, or a byte-equal copy the draft embedded in a larger unit, stays where the draft put it) and no sentence is ever deleted for resembling a disclaimer.

The **deterministic product rule is the only author** of that copy, in the answer's language. The templates are literal sentences, not a grammar: the canonical copy in either language, and the paraphrase shapes delivered answers actually carried — the claim alone, and the claim with the consult instruction the copy pairs with it. A sentence outside the set is answer content by construction, and the rule never widens itself to catch one.

The **dhaif warning and the machine-translation label keep their append-if-absent mechanism**. Their content sits beside the evidence the answer discusses, so their position is the model's to choose; the disclaimer is a closing promise, so its wording and position are the product's.

**Unchanged:** a pure refusal, an asserting refusal draft and the gate's ungrounded-citation refusal are not decorated. The generator is **not** instructed to write the disclaimer.

## Why

A suppression predicate made the control depend on the model. A paraphrase it matched left the canonical line out — and since only a closing rule paragraph reaches the footer, a prefixed paraphrase could leave the reader with **no disclaimer at all**. One it did not match shipped the canonical line after the model's weaker sentence, so the reader saw **two** disclaimers with the weaker one still on the page.

Writing the copy unconditionally removes that dependence: whatever the draft says, a canonical paragraph is present and it is the last one. Clearing the draft's units by template equality is what keeps the clearing one-directional: a frame that accepts any word the consult copy might contain cannot tell a sentence about the scholars' decision from a disclaimer, and a rule that can delete a sentence by misreading a word is not fixable by adding words.

Rejected: tightening the predicate to the canonical copy. It suppresses on the copy alone, so every paraphrase gains the canonical line **beside** it — the double disclaimer the module already refuses elsewhere, with the weaker promise still visible.

Rejected: accepting a paraphrase as satisfying the disclaimer. The control then stays model-dependent, a weaker promise ships whenever the model paraphrases badly, and the delivered text cannot show whether the rule fired.

Rejected: sharing the dhaif warning's mechanism. A weakness note's position is content, so appending beside it is fine; the disclaimer is not evidence-adjacent, so moving it is free.

Rejected: deleting every unit that carries the claim. A unit may use the claim in another sense, or carry the evidence it discusses; only equality with a template deletes.

## Consequences

- The rule owns the disclaimer's copy and its closing position; the client renders the footer from that position, so the copy and the footer cannot disagree.
- The trace records the rule when it changed the delivered text, so a removed template unit is visible as the rule firing rather than as an answer that happened to carry the copy.
- The prompt does not ask for the disclaimer: the rule would strip the sentence it buys, so a run with the rules disabled — no production path disables them — delivers no disclaimer.
- A model sentence that only advises consulting a scholar is a different promise and is preserved; a paraphrase outside the template set survives beside the close, a cosmetic second disclaimer where a deleted sentence would be a defect.
