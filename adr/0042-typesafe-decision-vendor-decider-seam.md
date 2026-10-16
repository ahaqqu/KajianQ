# ADR-0042: A decision-model vendor enters the catalog behind a bench gate and serves as the reviewer pre-gate

## Decision

A vendor that answers typed structured questions over a state — not chat, not embeddings — enters the allowlist behind a `Decider` seam beside `Provider` in `rag-core`, a vendor-name-free config-driven adapter in `infra`, and a serving role in the role map. Failures ride the provider error type, so retry and attempt-cost discipline stay uniform across both seams, and the engine's first non-chat protocol stays a closed list rather than an open string.

Serving adoption is the reviewer pre-gate: one batched decision call per answer, inside the existing reviewer stage, active wherever the vendor's key is bound, one question per citation position. A citation is supported at the threshold the seam defines, and every supported citation skips the paid reviewer. The order is fixed: the deterministic citation validator first and free, then the pre-gate, then the paid reviewer; a draft failing the validator or a generator-emitted refusal never spends. The pre-gate fails open, so it never gates quality alone.

Catalog entry, and any further serving role, is gated on a multilingual benchmark over the product's own evidence languages. The report is committed and the benchmark runs by hand, never in CI's spend path, and the bench-only candidate role stays bench-only, so a re-bench adds challengers without changing serving.

## Why

The candidate stages are the cheap-judgment ones — relevance screening, reranking, fuzzy citation verification ahead of the paid reviewer, feedback triage — and each touches the trust surface, so an input-priced model is what fits there. The vendor's published evidence is English-domain while the corpus is Arabic and Indonesian, so the standing precedent applies: the embedding default was decided by a benchmark, not asserted (ADR-0036).

Rejected: routing structured questions through the text-generation seam, which hides the question typing in prompt strings and lands the model in a chat chain it cannot answer; adopting first and measuring in staging, which lets an unmeasured vendor touch citation verification before multilingual evidence exists; a dedicated enable switch, when unbinding the key already stops the spend by configuration; a closed pre-gate, because a gate fronting a paid reviewer earns its place by removing spend and may not also remove quality.

## Consequences

- Fail-open is exhaustive and is what makes the adoption safe: a doubtful, malformed, missing or out-of-range answer, a vendor failure, or a draft with nothing to judge escalates to the paid reviewer. Out-of-range reads as unusable, never as support, and the reason is persisted trace content.
- The clean path pays one input-priced batched call instead of the escalation-tier reviewer; the escalated path pays both, accepted because escalation happens only on a doubted answer.
- Spend and verdict are trace content: the LLM-call event carries model identity, tokens, latency and cost including a failed attempt that reached the vendor, and the decision event carries the per-citation scores.
- Personal-data eligibility binds at the seam, not only at resolution: serving drops an ineligible candidate and reports it, and the adapter refuses it before the wire.
- The gate cannot read as passed — it exits non-zero when no keyed candidate passes — and the generic half of the bench runner is extracted when a second adoption lands rather than copied.
- **Revisit when** a second decision-model vendor is benched, or a serving stage beyond citation verification wants the seam.
