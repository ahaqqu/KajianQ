# ADR-0056: The not-a-fatwa disclaimer is the rule's canonical closing copy, written exactly once

## Decision

Every delivered answer ends with **exactly one** not-a-fatwa/consult-ulama disclaimer, and the
**deterministic product rule is its only author**. The copy is the product's, in the answer's
language; a model paraphrase of the claim neither satisfies the rule nor survives beside it.

Any disclaimer-like sentence in the model's draft — the claim worded its own way, with or without a
rule marker or a label prefix — is **removed** before the copy is written. The rule writes the
canonical copy as the answer's **final paragraph**. A draft that already closes with that copy is
delivered unchanged.

The **dhaif warning and the machine-translation label keep their append-if-absent mechanism**. Their
content sits beside the evidence the answer discusses, so their position is the model's to choose;
the disclaimer is a closing promise, so its wording and position are the product's.

**Unchanged:** a pure refusal, an asserting refusal draft and the gate's ungrounded-citation refusal
are not decorated; the generator is still instructed to close with the disclaimer, and the rule
exists so the promise does not depend on its following that instruction.

## Why

A suppression predicate made the control depend on the model. A paraphrase it matched left the
canonical line out — and since only a closing rule paragraph reaches the footer, a prefixed
paraphrase could leave the reader with **no disclaimer at all**. A paraphrase it did not match would
have shipped the canonical line after the model's weaker sentence, so the reader saw **two**
disclaimers with the weaker one still on the page.

Removing the draft's wording and writing one copy needs neither predicate: there is no shape in which
the canonical copy can be suppressed, duplicated, or left in a weaker form. The cost is that the
model's own disclaimer sentence does not survive; it is the one sentence whose wording the product
promises, and a closing promise has no context to be placed in.

Rejected: tightening the predicate to the canonical copy. It suppresses on the copy alone, so every
paraphrase gains the canonical line **beside** it — the double disclaimer the module already refuses
elsewhere, with the weaker promise still visible.

Rejected: accepting a paraphrase as satisfying the disclaimer. The control then stays model-dependent,
a weaker promise ships whenever the model paraphrases badly, and the delivered text cannot show
whether the rule fired.

Rejected: sharing the dhaif warning's mechanism. Appending a canonical warning beside an informal
weakness note is the accepted trade there because the note's position is content; the disclaimer is
not evidence-adjacent, so moving it costs nothing and removing a weaker duplicate is the point.

## Consequences

- The rule owns the disclaimer's copy and its closing position; the client renders the footer from
  that position, so the copy and the footer cannot disagree.
- The trace records the rule when it changed the delivered text, so a normalised paraphrase is
  visible as the rule firing rather than as an answer that happened to carry the copy.
- The generator's instruction to close with the disclaimer stays: a run with the rules disabled must
  still read as an answer, but the delivered wording no longer depends on the model obeying it.
- A model sentence that only advises consulting a scholar is a different promise and is preserved.
