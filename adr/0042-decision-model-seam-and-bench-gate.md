# ADR-0042: The decision-model seam serves the reviewer pre-gate and the retrieval rerank behind a bench gate

## Decision

A model that answers typed structured questions over a state — not generation,
not embeddings — rides its own `Decider` seam beside `Provider` in the engine,
config-driven and vendor-name-free, with failures on the provider error type so
retry and attempt-cost discipline stay uniform across both seams. The seam's
question typing travels as data; the answer typing is contractual on the wire:
a serving candidate is either a typed-question protocol vendor (the preferred
head when one is benched) or a chat-completions candidate whose response the
request pins to a strict JSON schema — and an answer that arrives malformed,
out of range, or off the option set fails the call rather than being coerced.

The serving role carries two adoptions, both active wherever the candidate's
key is bound and with no enable switch, and both **fail-open** — a doubtful,
malformed, missing or out-of-range answer, a vendor failure, or too little
evidence to judge leaves the downstream path exactly as it was:

- **The reviewer pre-gate** — one batched decision call per answer, inside the
  existing reviewer stage, one question per citation position; the
  deterministic citation validator runs first and free, a generator-emitted
  refusal never spends, and only an affirmatively cleared answer skips the
  paid reviewer.
- **The retrieval rerank** — one batched choice call over a retrieval's fused
  candidates; the ranking is an ordering only, and no candidate is added or
  dropped.

Adoption is gated on a multilingual benchmark over the product's own evidence
languages: a candidate serves only when the committed report passes for it, the
bench runs by hand (never in CI's spend path), the bench-only candidate role
stays bench-only, and a re-bench that stops passing withdraws the adoption.
Failing open can only leave the fused order standing or remove spend on an
answer the pre-gate affirmatively cleared; neither adoption gates quality alone.

## Why

The candidate stages are the cheap-judgment ones — relevance screening,
reranking, fuzzy citation verification ahead of the paid reviewer, feedback
triage — and each touches the trust surface, so an input-priced model fits and
the quality claim must be measured, not asserted: the corpus evidence is Arabic
and Indonesian, so the standing precedent applies (the embedding default was
decided by a benchmark, ADR-0036). This record originally rejected riding the
text-generation seam because prompt-carried typing landed decisions on a chat
chain no one measured. The aggregator migration (ADR-0069) retired the
typed-protocol vendor, and the rewrite narrows that rejection instead of
reversing it: the answer shape is now contractual on the wire, and the same
bench still measures the candidate on the product's evidence languages before
it touches citation verification.

## Consequences

- Fail-open is exhaustive and is what makes both adoptions safe: every refused
  read is persisted trace content — the rule that refused it and the item it
  refused — never a silent reorder or a silent escalation.
- The clean path pays one input-priced batched call instead of the escalation
  tier; the rerank adds one per retrieval with two or more fused candidates,
  on the request's critical path.
- Spend and verdict are trace content: every call carries model identity,
  tokens, latency and cost including a failed attempt that reached the vendor,
  and the trace total equals the sum of its recorded calls.
- Personal-data eligibility binds at the seam: a serving call that declares
  personal data never reaches a vendor whose config forbids it, and the
  refusal is raised before the wire and spends nothing.
- The gate cannot read as passed — it exits non-zero when no keyed candidate
  passes.
- **Revisit when** a second decision vendor is benched, or a serving stage
  beyond citation verification and the retrieval rerank wants the seam.
