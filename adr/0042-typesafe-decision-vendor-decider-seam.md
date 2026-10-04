# ADR-0042: A decision-model vendor enters the catalog behind a bench gate, and serves as the reviewer pre-gate

## Decision

A vendor answering typed structured questions over a state — not chat, not embeddings, priced on input tokens only —
enters the allowlist behind a `Decider` seam beside `Provider` in `rag-core`, a vendor-name-free config-driven adapter
in `infra`, and a serving role in the role map. Failures ride the provider error type, so retry and attempt-cost
discipline stay uniform across both seams.

Serving adoption is the reviewer pre-gate: one batched decision call per answer, inside the existing reviewer stage,
active wherever the vendor's key is bound. It fails open — any doubt escalates to the paid reviewer — so it can only
remove spend on an answer it affirmatively cleared, never gate quality alone.

Entry to the catalog, and to any further serving role, is gated on a multilingual benchmark over the product's own
evidence languages; its report is committed and it runs by hand, never in CI's spend path.

## Why

The candidate stages are the cheap-judgment ones — relevance screening before assembly, reranking the fused
candidates, fuzzy citation verification ahead of the paid reviewer, feedback triage — and each touches the trust
surface. The vendor's published evidence is English-domain while the corpus is Arabic and Indonesian, so the standing
precedent applies: the embedding default was decided by a benchmark, not asserted (ADR-0036).

The alternatives, each rejected with its reason. Routing structured questions through the existing text-generation
seam would hide the question typing in prompt strings and let the model land in a chat fallback chain it cannot
answer. Adopting first and measuring in staging would let an unmeasured vendor touch citation verification before any
multilingual evidence existed, and a smoke run would not cover Arabic/Indonesian judgment. A dedicated enable/disable
switch is refused because the requirement one would serve — stopping the vendor's spend without a deploy — is met by
the key binding itself, which is configuration, not code. A closed pre-gate is refused because a gate fronting a paid
reviewer earns its place by removing spend: if it could also remove quality, an unmeasured model would become the
gate. Skipping the vendor is refused because its price profile justifies one bench run's effort.

## Consequences

Fail-open is exhaustive: a doubtful, malformed, missing, non-finite, or out-of-range answer, a vendor failure, or a
draft with nothing to judge all escalate — and an out-of-range value reads as unusable, never as support. The
escalation reason is persisted trace content, not a server log.

Spend and verdict are trace content: the LLM-call event carries model identity, tokens, latency, and computed cost
including a failed attempt that reached the vendor, the decision event carries the per-citation scores, and the trace
total stays the sum of the recorded calls. The clean path pays a batched input-priced call instead of the
escalation-tier reviewer and the escalated path pays both — marginally worse, accepted, because escalation happens
only on a doubted answer.

`DecisionSpec.personalData` is **required** — a compile error to drop — and the register rule is enforced at the seam,
not only at resolution: serving drops an ineligible candidate and reports it, and the adapter fails such a spec before
the wire. Eligibility rests on a data-processing agreement with the vendor.

The gate exits non-zero when no keyed candidate passes, so a failed gate cannot read as passed; its floors, case-count
rule, and NOT RUN posture are the harness's contract, and its language-neutral prompts live in the domain pack. The
measured gate used isolated single-question calls while serving sends one batched call, so positional pairing under
sibling citations is extrapolated, not measured — the batched variant is standing duty.

The composition root's startup posture line resolves through the same provider factory as the request path, so it
cannot drift: it names the pre-gate and reviewer states, the absent-key env vars, and the candidates the personal-data
posture dropped — names only, never a value.
