# ADR-0042: A decision-model vendor enters the catalog behind a bench gate, and serves as the reviewer pre-gate

## Decision

A vendor answering typed structured questions over a state — not chat, not embeddings — enters the allowlist behind a
`Decider` seam beside `Provider` in `rag-core`, a vendor-name-free config-driven adapter in `infra`, and a serving
role in the role map. Failures ride the provider error type, so retry and attempt-cost discipline stay uniform across
both seams, and the engine's first non-chat protocol stays a closed list, not an open string.

Serving adoption is the reviewer pre-gate: one batched decision call per answer, inside the existing reviewer stage,
active wherever the vendor's key is bound, one question per citation position. A citation is supported at the
per-citation threshold the seam defines, and every citation supported skips the paid reviewer. Order: the
deterministic citation validator first and free, then the pre-gate, then the paid reviewer; a draft failing the
validator or a generator-emitted refusal never spends. The pre-gate fails open, so it never gates quality alone.

Catalog entry, and any further serving role, is gated on a multilingual benchmark over the product's own evidence
languages; the report is committed and the bench runs by hand, never in CI's spend path, and the bench-only candidate
role stays bench-only so a re-bench adds challengers without changing serving.

## Why

The candidate stages are the cheap-judgment ones — relevance screening, reranking, fuzzy citation verification ahead
of the paid reviewer, feedback triage — and each touches the trust surface. The model is input-priced only, which is
what fits it there. The vendor's published evidence is English-domain while the corpus is Arabic and Indonesian, so
the standing precedent applies: the embedding default was decided by a benchmark, not asserted (ADR-0036).

The alternatives, each rejected with its reason. Routing structured questions through the text-generation seam would
hide the question typing in prompt strings and land the model in a chat chain it cannot answer. Adopting first and
measuring in staging would let an unmeasured vendor touch citation verification before any multilingual evidence
existed, and a smoke run cannot cover Arabic/Indonesian judgment. A dedicated enable/disable switch is refused because
stopping the vendor's spend without a deploy is met by the key binding itself, which is configuration, not code. A
closed pre-gate is refused because a gate fronting a paid reviewer earns its place by removing spend, and the pre-gate
can only remove spend on an answer it affirmatively cleared; if it could also remove quality, an unmeasured model
would become the gate. Skipping the vendor is refused: its price profile justifies one bench run's effort.

## Consequences

Evidence is draft-grade (`v0-draft`, owner sign-off pending), read as an aggregate band, not a powered comparison;
fail-open design, not the score, is what makes the adoption safe. Fail-open is exhaustive: a doubtful, malformed,
missing, non-finite or out-of-range answer, a vendor failure, or a draft with nothing to judge escalates; out-of-range
reads as unusable, never support, and the reason is persisted trace content.

Spend and verdict are trace content: the LLM-call event carries model identity, tokens, latency, and cost including a
failed attempt that reached the vendor, the decision event the per-citation scores, and the trace total stays the sum
of the recorded calls. The clean path pays a batched input-priced call instead of the escalation-tier reviewer; the
escalated path pays both, marginally worse and accepted, because escalation happens only on a doubted answer.

`DecisionSpec.personalData` is **required** — a compile error to drop — and the register rule binds at the seam, not
only at resolution: serving drops an ineligible candidate and reports it, and the adapter fails it before the wire.
Eligibility rests on a vendor data-processing agreement.

A failed gate cannot read as passed: the CLI exits non-zero when no keyed candidate passes, and the floors, case-count
rule, NOT RUN posture and prompts are the harness's contract. The gate measured single-question calls; serving sends
one batched call, so positional pairing under siblings is extrapolated; the batched variant is standing duty.

Adoption #2: the generic half of the runner is to be extracted when the second adoption lands rather than copied,
because with a single adopter the interface would be a guess. The startup posture line resolves through the request
path's own provider factory, so it cannot drift: it names the pre-gate and reviewer states, the absent-key env vars,
and the candidates the personal-data posture dropped — names only, never a value.
