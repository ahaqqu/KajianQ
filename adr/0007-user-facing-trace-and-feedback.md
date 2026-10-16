# ADR-0007: Every answer ships its trace, and feedback is anchored to a trace element

## Decision

Every answer ships with an expandable trace of how it was built — router intent, sub-queries, retrieved chunks with their scores, model identity — not only its final citations. The panel is the feedback instrument, never interface clutter.

The trace shapes are first-class shared contracts: one definition, consumed by the pipeline, the interface, administration and the eval harness. Two invariants ride on them — every call's tokens, latency and cost attach to the trace of the answer or run that triggered it, and a run's recorded cost equals the sum of its recorded calls; refusals and suppressions carry a reason and the stage that stopped them, so silence stays as auditable as an answer.

A trace belongs to the user it answers and is erased with them. Feedback names contract identifiers only — a thumb, or a flag on a trace element — is stored only when the persisted trace grounds the anchor, is idempotent per user, answer and element, and accepted items become Golden Set cases.

## Why

Hiding the machinery is the norm and this product deliberately deviates: it is open source and asks its users to help improve quality. A vague "bad answer" report is not actionable; "this passage is mistranslated" is, and the trace is what makes a specific element addressable at all.

The shared contract is what keeps the trace honest. Model identity, tokens, latency and cost are recorded where the call happens rather than reconstructed for display, so the panel renders persisted evidence and a cost figure cannot come from anywhere but the calls that ran. A per-user trace resolves the tension between auditability and erasure in favour of erasure, and anchoring is enforced against the trace rather than trusted from the client, because a row asserting a defect that did not happen would train the review queue on invented findings.

## Consequences

- The trace contract only grows by optional, version-bumped fields; it never gains a required field and never renames one without migrating persisted traces, so older traces stay readable.
- A new event kind is additive on the same terms: presence of an event is the signal, absence is never read as a negative, and a reader older than the writer rejects the unknown kind.
- An ungrounded flag is refused rather than stored, and a degraded server-side derivation answers a service-unavailable error instead of blaming the user.
- Feedback rows carry the user id and cascade with it.
