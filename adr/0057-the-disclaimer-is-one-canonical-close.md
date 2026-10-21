# ADR-0057: The not-a-fatwa disclaimer is the rule's canonical closing copy, written exactly once

## Decision

The **deterministic product rule is the only author** of the not-a-fatwa/consult-ulama disclaimer.
It writes the product's copy, in the answer's language, as the answer's **final paragraph**. The
canonical close is always present, exactly once, as the final paragraph; a disclaimer-shaped sentence
is removed only when its unit is wholly a disclaimer — otherwise the answer may carry the model's
paraphrase beside it, never instead of it.

A unit is wholly a disclaimer when every word in it belongs to the claim and the consult instruction
the copy pairs with that claim, under an optional rule marker or wrap-only markup. A unit that mixes
the claim with answer content — a dhaif note, a table row, a contrastive clause — is **left
untouched**: the rule never deletes a sentence it cannot prove is the disclaimer. A draft that
already closes with the canonical copy is delivered unchanged.

The **dhaif warning and the machine-translation label keep their append-if-absent mechanism**. Their
content sits beside the evidence the answer discusses, so their position is the model's to choose;
the disclaimer is a closing promise, so its wording and position are the product's.

**Unchanged:** a pure refusal, an asserting refusal draft and the gate's ungrounded-citation refusal
are not decorated. The generator is **not** instructed to write the disclaimer.

## Why

A suppression predicate made the control depend on the model. A paraphrase it matched left the
canonical line out — and since only a closing rule paragraph reaches the footer, a prefixed
paraphrase could leave the reader with **no disclaimer at all**. One it did not match shipped the
canonical line after the model's weaker sentence, so the reader saw **two** disclaimers with the
weaker one still on the page.

Writing the copy unconditionally removes that dependence: whatever the draft says, a canonical
paragraph is present and it is the last one, and clearing the draft's own disclaimer-shaped units
keeps the reader from meeting the promise twice. The rule is not a classifier: a paraphrase folded
into a sentence with answer content survives beside the close, the price of never deleting a sentence
that is not a disclaimer.

Rejected: tightening the predicate to the canonical copy. It suppresses on the copy alone, so every
paraphrase gains the canonical line **beside** it — the double disclaimer the module already refuses
elsewhere, with the weaker promise still visible.

Rejected: accepting a paraphrase as satisfying the disclaimer. The control then stays model-dependent,
a weaker promise ships whenever the model paraphrases badly, and the delivered text cannot show
whether the rule fired.

Rejected: sharing the dhaif warning's mechanism. A weakness note's position is content, so appending
beside it is fine; the disclaimer is not evidence-adjacent, so moving it is free.

Rejected: deleting every unit that carries the claim. A unit may use the claim in another sense, or
carry the evidence it discusses; removal is scoped to units that are wholly the disclaimer.

## Consequences

- The rule owns the disclaimer's copy and its closing position; the client renders the footer from
  that position, so the copy and the footer cannot disagree.
- The trace records the rule when it changed the delivered text, so a removed paraphrase is visible as
  the rule firing rather than as an answer that happened to carry the copy.
- The prompt does not ask for the disclaimer: the rule would strip the sentence it buys, so a run with
  the rules disabled — no production path disables them — delivers no disclaimer.
- A model sentence that only advises consulting a scholar is a different promise and is preserved.
