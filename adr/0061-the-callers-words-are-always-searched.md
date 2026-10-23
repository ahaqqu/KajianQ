# ADR-0061: The caller's words are always searched, and a model paraphrase is additive

## Decision

The caller's verbatim question is always one of the texts retrieval runs, as its
own sub-query carrying the `factual` rule's role, whatever the router model
phrases on top of it. The model's paraphrases stay in the set as additive
angles: an entry the reply labels `factual` sits beside the caller's words and
never stands in for them. The caller's entry is attributed to the rule that
produced it, never to the model, so the trace cannot publish the caller's words
as the model's judgment. A reply that echoes the question adds no second
spelling of it.

The bound and the content admission are unchanged: the set stays at 2–4, a text
carrying no letter and no digit is never embedded, and when the ceiling forces a
choice the caller's words keep their slot and a model paraphrase is what the
ceiling spends.

## Why

A question and a paraphrase are not interchangeable retrieval queries. The
router model phrases in its own vocabulary — classical terms, Arabic
transliteration, the topic it inferred — and that vocabulary can be absent from
the corpus even where the caller's words are present in it. Replacing the
caller's text with the model's therefore narrows the search in a way the caller
cannot see: the pipeline reports a complete, plausible retrieval — a full
sub-query list, a route, a citation set — and the missing evidence never
announces itself. The caller's words are the one text known to be phrased for
the question as asked, so they are the floor the model's angles are added to,
not a slot the model's angles compete for. Keeping both is additive recall at
the price of one embed and a pair of searches over a text already in hand; no
model call is added.

## Consequences

- The domain pack's decomposition repair owns the invariant, beside the rule
  coverage it already guarantees.
- Every sub-query keeps its origin, so a repaired route reads as repaired on the
  persisted trace and the caller's entry is never the model's judgment.
- The stage's ceiling still bounds the set and its cost; the caller's entry is
  spent first.
- A paraphrase that displaces nothing remains a first-class retrieval angle.
