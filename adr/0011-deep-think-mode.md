# ADR-0011: Deep Think is an opt-in iterative retrieval mode under hard caps, never a read-everything mode

## Decision

Hard questions need broader coverage than a single top-k pass gives, so Deep Think is an opt-in mode: iterative retrieval rounds — a draft answer, then gap and contradiction detection, then re-retrieval — over a deeper candidate pool than the default path, with the cheap tier scoring candidates for relevance before assembly, all under hard caps on rounds, context size and per-query cost, and all traced.

The trace shows coverage explicitly — passages examined, judged relevant and used — so comprehensiveness is a visible, auditable property rather than a claim. The default chat path keeps its top-k discipline unchanged.

## Why

Reading every found document into the context is rejected on three grounds: long contexts degrade per-passage recall, irrelevant material actively misleads the generator, and cost and latency grow by orders of magnitude. A deep candidate pool with cheap relevance scoring buys coverage at a bounded price, and the caps are what keep the bound real.

Rejected: reading all found documents into the context; unbounded rounds; promoting Deep Think to the default path before it beats the baseline on the Golden Set in recall and faithfulness at bounded cost.

## Consequences

- The mode is opt-in, and the default path's behaviour is untouched.
- The round, context and cost caps are configuration, so an operator tunes the bound without a code change.
- Coverage is trace content, so a run's comprehensiveness is auditable after the fact.
- **Revisit when** it beats the baseline on the Golden Set at bounded cost — that is what promotes it beyond opt-in — or a round's marginal evidence stops paying for its cost.
