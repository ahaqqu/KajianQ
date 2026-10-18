# ADR-0053: A question carrying no letter and no digit is declined with canned copy, at no provider cost

## Decision

A run whose route the gate marked content-free — the caller's text carried no letter and no digit in
any script, so the router asked no model anything (ADR-0051) — is answered with the product's
**canned, localized decline**, and the generator and the reviewer are never entered. The path makes
**no provider call at all**: no router call, no embed, no search, no generation, no review. Zero cost
is a property of the path rather than a measurement of it: the answer is fixed copy, so there is
nothing to price.

The decline is a **first-class answer**. It is the run's settled text, recorded on the persisted
trace and rendered from that record, never a bare HTTP response. Its record carries the route's
content-free marking unchanged, the decline's own trigger, and **no cost record**, because nothing was
bought.

The **test is the router's own**. A text carrying no letter and no digit is not a question, so it has
no answer to generate; a route the model read is never declined, whatever it contains. The decline's
copy is **product copy**, localized with `id` first and `en` alongside, and it lives on the **product
side** — the engine carries the text opaquely and names neither a wording nor a language.

**Unchanged:** the answer prompt, and the generated refusal for a content-bearing question that cannot
be grounded. This record is about the input that is not a question, not about refusals: a decline and a
Refusal are different answers, told apart by their trigger and by their copy.

## Why

The route gate stopped the router call, the embed and the searches; the answer stage still bought a
generation for a text the gate had already decided was not a question. The model's output there is
invariant — asked to decline, it declines in the canonical sentence — so the call bought nothing the
pipeline did not already know, on the one class of input whose defining property is that there is
nothing to search for. Removing it makes the class' promise true by construction instead of true by the
model's restraint, and it removes a spend an unauthenticated caller can repeat at will.

The decline is read off the route rather than re-derived from the text, because a second spelling of
the content test is a second chance to disagree with the route the answer has to be about: the router
already trimmed and admitted the caller's question, and the answer stage reads that decision.

Rejected: teaching the generator to skip its own provider call. The reviewer runs after it and would be
judging a draft no model wrote, so both stages would have to know the run had nothing to answer — one
fact with two owners, and a trace that depends on both being right; the run owns it instead.

Rejected: reusing the canonical refusal sentence for the decline. A decline and a Refusal answer
different questions, and a reader who cannot tell them apart without opening the trace has already lost
the distinction the vocabulary exists to keep.

## Consequences

- The decline is consulted through an optional seam on the pipeline run, so a consumer with no decline
  copy wired still runs the five stages unchanged.
- The engine records the decline from the seam's own verdict: a run cannot decline without the trace
  saying so, nor without a text to deliver.
- A declined run's trace carries its intent, retrieval and assembly events as before, the decline's
  record where the generation would stand, and no `llm_call` and no cost anywhere on it.
- The trace's refusal-trigger vocabulary gains the decline's — the one member that is not a Refusal.
- The decline is localized with the answer and follows the question's language like every other answer.
- A declined run is not a candidate for the sampled faithfulness review — or any paid post-hoc judge of
  an answer: there is no answer to judge, and this path's contract is that it spends nothing.
