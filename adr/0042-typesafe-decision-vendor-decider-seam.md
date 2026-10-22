# ADR-0042: A decision-model vendor enters the catalog behind a bench gate and serves the reviewer pre-gate and the retrieval rerank

## Decision

A vendor that answers typed structured questions over a state — not chat, not embeddings — enters the allowlist behind a `Decider` seam beside `Provider` in `rag-core`, a vendor-name-free config-driven adapter in `infra`, and a serving role in the role map. Failures ride the provider error type, so retry and attempt-cost discipline stay uniform across both seams, and the engine's first non-chat protocol stays a closed list rather than an open string.

The serving role carries two adoptions, both active wherever the vendor's key is bound and with no enable switch:

- **The reviewer pre-gate** — one batched decision call per answer, inside the existing reviewer stage, one question per citation position. A citation is supported at the threshold the seam defines, and every supported citation skips the paid reviewer. The order is fixed: the deterministic citation validator first and free, then the pre-gate, then the paid reviewer; a draft failing the validator or a generator-emitted refusal never spends.
- **The retrieval rerank** — one batched `Choice` call over a retrieval's fused candidates, reordering them by the returned distribution before context assembly. The ranking is an ordering only: no candidate is added or dropped, the chunks the deterministic arms contributed keep their positions, and the question's wording belongs to the domain pack.

Both adoptions fail open: a doubtful, malformed, missing or out-of-range answer, a vendor failure, or too little evidence to judge leaves the downstream path exactly as it was. Failing open can only leave the fused order standing or remove spend on an answer the pre-gate affirmatively cleared; neither adoption gates quality alone. A cancellation is not a failure and is never read as one.

Catalog entry, and any further serving role, is gated on a multilingual benchmark over the product's own evidence languages. The report is committed and the benchmark runs by hand, never in CI's spend path, and the bench-only candidate role stays bench-only, so a re-bench adds challengers without changing serving. The rerank is a serving adoption on that same gate: the committed report passes for this vendor, and a re-bench that stops passing withdraws the adoption.

## Why

The candidate stages are the cheap-judgment ones — relevance screening, reranking, fuzzy citation verification ahead of the paid reviewer, feedback triage — and each touches the trust surface, so an input-priced model is what fits there. The vendor's published evidence is English-domain while the corpus is Arabic and Indonesian, so the standing precedent applies: the embedding default was decided by a benchmark, not asserted (ADR-0036).

Retrieval's fused order is a similarity proxy, and the evidence it admits is what the answer must be built from. A decision model can order that evidence by the question itself for one input-priced call, without the re-ask and re-embed a second retrieval pass would cost — and because the adoption reorders only what retrieval already admitted, it cannot remove a passage the generator would otherwise see.

Rejected: routing structured questions through the text-generation seam, which hides the question typing in prompt strings and lands the model in a chat chain it cannot answer; adopting first and measuring in staging, which lets an unmeasured vendor touch citation verification before multilingual evidence exists; a dedicated enable switch, when unbinding the key already stops the spend by configuration; a closed pre-gate, because a gate fronting a paid reviewer earns its place by removing spend and may not also remove quality; a rerank that may drop candidates, because the reranker's judgment would then decide what evidence exists.

## Consequences

- Fail-open is exhaustive and is what makes both adoptions safe: every doubtful read is persisted trace content — the rule that refused it and the item it refused — never a silent reorder or a silent escalation.
- The clean path pays one input-priced batched call instead of the escalation-tier reviewer; the escalated path pays both, accepted because escalation happens only on a doubted answer. The rerank adds one input-priced call per retrieval, on the request's critical path, so a query pays its latency as well as its spend.
- Spend and verdict are trace content: the LLM-call event carries model identity, tokens, latency and cost including a failed attempt that reached the vendor, the decision event carries the per-citation scores, and the rerank event carries both the fused score and the model's probability per candidate. The trace total equals the sum of its recorded calls.
- Personal-data eligibility binds at the seam, not only at resolution: serving drops an ineligible candidate and reports it, and the adapter refuses it before the wire.
- The gate cannot read as passed — it exits non-zero when no keyed candidate passes — and the generic half of the bench runner is extracted when a second adoption lands rather than copied.
- **Revisit when** a second decision-model vendor is benched, or a serving stage beyond citation verification and the retrieval rerank wants the seam.
