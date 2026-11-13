# ADR-0042: The decision-model seam serves the reviewer pre-gate and the retrieval rerank behind a bench gate

## Decision

A model that answers typed structured questions over a state — not generation,
not embeddings — rides its own `Decider` seam beside `Provider`, config-driven
and vendor-name-free, its failures on the provider error type so retry and
attempt-cost discipline stay uniform across both seams. The typing travels as
data; the answer typing is contractual on the wire: whichever transport the
candidate's config names — the chat wire's strict JSON schema or the typed
questions wire whose primitives are the seam's own question types — an answer
that arrives malformed, out of range, or off the option set fails the call
rather than being coerced.

The seam serves two adoptions, both active wherever the candidate's key is
bound and with no enable switch, and both **fail-open** — a doubtful, missing
or vendor-failed read leaves the path as it was, so failing open can only
leave the fused order standing or remove spend on an answer the pre-gate
affirmatively cleared; neither adoption gates quality alone:

- **The reviewer pre-gate** — one batched decision call per answer, inside the
  existing reviewer stage; the deterministic validator runs first and free, a
  refusal never spends, and only an affirmatively cleared answer skips the
  paid reviewer.
- **The retrieval rerank** — one batched choice call over a retrieval's fused
  candidates; an ordering only — no candidate is added or dropped.

A candidate serves production only when a committed multilingual benchmark
report passes for it over the product's own evidence languages; the bench runs
by hand (never in CI's spend path), the bench-only candidate role stays
bench-only, and a re-bench that stops passing withdraws the adoption. That
state is config: `benchAdoption` on the serving role, named by the boot
posture report — `provisional` = the head ships pending the committed report
(ADR-0069 ships it so), `committed` = a committed report passed for this head.

## Why

The candidate stages are the cheap-judgment ones — relevance screening,
reranking, fuzzy citation verification ahead of the paid reviewer, feedback
triage — each touching the trust surface, so an input-priced model fits and
the quality claim must be measured, not asserted: the corpus evidence is Arabic
and Indonesian, so the standing precedent applies (the embedding default was
decided by a benchmark, ADR-0036). Prompt-carried typing would land decisions
on a chat chain no one measured; pinning the answer shape on the wire is what
makes a chat-completions or typed-questions candidate measurable by the same
bench.

## Consequences

- Fail-open is exhaustive and is what makes both adoptions safe: every refused
  read is persisted trace content — the rule that refused it and the item it
  refused — never a silent reorder or a silent escalation.
- The clean path pays one input-priced batched call instead of the escalation
  tier; the rerank adds one per retrieval with two or more fused candidates.
- Spend and verdict are trace content — identity, tokens, latency, cost per
  call, failed attempts included — totalling exactly its recorded calls.
- Personal-data eligibility binds at the seam: a personal-data call never
  reaches a vendor whose config forbids it — refused before the wire, spending
  nothing.
- The gate cannot read as passed — it exits non-zero when no keyed candidate
  passes.
- **Revisit when** a serving stage beyond citation verification and the
  retrieval rerank wants the seam.
