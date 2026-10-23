# ADR-0062: The caller's own query is a priority retrieval angle

## Decision

The caller's verbatim question is a retrieval angle with priority of its own.
The leading dense hits of the caller's own sub-query enter the context whatever
their fusion rank, carry a provenance label of their own, and keep the position
retrieval gave them through the decision-model rerank. The guarantee is bounded
by one small fixed number, and it is recorded on the answer's Trace as its own
typed event naming the bound, the ids, and which of them the returned set
already held.

It issues no search. The caller's sub-query is embedded and searched by the
ordinary fan-out; this rule only selects from the list that search already
returned. A route with no caller sub-query — a question carrying no letter and
no digit, which is not decomposed at all — is unaffected.

## Why

Fusion weighs every sub-query list alike, and the router's paraphrases outnumber
the caller's single list. A row the caller's own wording ranks highly can
therefore lose to rows that several paraphrase lists place mid-rank, and the
loss is silent: retrieval reports a complete, plausible set, the row the caller
asked about is absent or buried, and the answer cites what outvoted it.

The caller's words are the one query guaranteed to be phrased in the user's
vocabulary; the model phrases in its own. That makes the caller's list a
retrieval angle rather than one vote among equals: its strongest rows are
evidence the vote must not be able to discard. The guarantee is what makes the
caller's angle independent of how many paraphrases the router happened to
produce.

Weighting the caller's list inside fusion was rejected. A weight is a number to
tune against one corpus and one router, it still loses to enough lists, and it
moves every row's fused score instead of protecting the rows that matter.

## Consequences

- The retriever owns the selection and the bound. The rerank keeps its existing
  contract: a labelled chunk already keeps the position the wrapped retriever
  gave it, so the guaranteed rows are simply not offered for reordering.
- The guaranteed hits are context, so they grow the assembled context and the
  paid prompts that read it. The rule itself makes no provider call and no store
  read.
- When the fused block left beside the guaranteed rows is too small to rank, the
  rerank keeps its existing "not enough candidates" verdict and makes no call.
- A row already in the returned set is moved and labelled, never duplicated, and
  keeps a more specific arm's label; the trace's event says how much of the
  guarantee was already present.
