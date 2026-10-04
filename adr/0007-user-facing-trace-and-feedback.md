# ADR-0007: Every answer ships its trace, and feedback is anchored to a trace element

## Decision

Every KajianQ answer ships with an expandable trace of how it was built — router intent, sub-queries,
retrieved chunks with scores, model identity — not just its final citations. The panel is the
feedback instrument, never UI clutter.

`Trace`, `TraceEvent`, and `CostRecord` are first-class types in `packages/contracts`, one shape
consumed by the pipeline, the UI, admin, and the eval harness. Two invariants ride on it: every call's
tokens, latency, and cost attach to the trace of the answer or run that triggered it, and a run's
recorded cost equals the sum of its recorded calls, so an untraced call is a defect; refusals and
suppressions carry reason and stage, so silence stays as auditable as an answer.

A trace belongs to the user it answers and is erased with them on self-deletion. Feedback names
contract identifiers only — one shape per request, an anonymous thumb or a flag on a trace element —
and is stored only when the persisted trace grounds the anchor.

## Why

Hiding the machinery is the norm and this product deliberately deviates: it is open source and asks
users to help improve quality. A vague "bad answer" report is not actionable; "this chunk is
mistranslated" is, and the trace is what makes a specific element addressable at all.

The shared contract is what keeps the trace honest. Model identity, tokens, latency, and cost are
recorded where the call happens rather than reconstructed for display, and a refusal is recorded
like an answer, so the panel renders persisted evidence and a cost figure cannot come from anywhere
but the calls that ran. A per-user trace is the tension between auditability and erasure resolved in
favour of erasure: the anonymous case has no retention claim worth the exception.

Anchoring is enforced against the trace rather than trusted from the client. A flag the evidence
contradicts is refused rather than stored, because a row asserting a defect that did not happen
would train the review queue on invented findings. The same flag is idempotent per user, answer, and
element, so a repeated submission cannot inflate the queue it feeds.

## Consequences

- The `Trace` shape only ever grows by optional, version-bumped fields; it never gains a required
  field and never renames or removes one without migrating persisted traces. The store reader
  tolerates missing optional fields and strips unknown future keys, so older traces stay readable.
- A new event kind is additive on the same terms and does not bump the version: the kind union only
  grows, so a trace persisted before a kind existed carries no event of it and still parses.
  Presence of an event is the signal; absence is ambiguous across the kind's deploy instant, and no
  reader may take a missing event as a negative. A reader older than the writer still rejects the
  unknown kind, which is what stops an untyped record from persisting.
- The reviewer stage records the product-rules event wherever the deterministic product rules are
  applied, including the exit that skips them for the decision pre-gate and records no review event.
  Its presence means the rules ran; an empty applied list means they ran and appended nothing. The
  delivered text stays the single source of truth for what the answer says.
- Category↔anchor-type pairing is enforced by the shared contract, so a malformed combination fails
  the parse instead of reaching the store. An ungrounded flag is a validation error, while a
  degraded server-side derivation answers a service-unavailable error rather than blaming the user.
- Feedback rows carry the user id and cascade with it, and resolve their target by the trace's
  canonical message id, which the response echoes back. The queue counts verdicts, not retries. The
  flag affordances live on the answer, on each trace source row, and in the citation sheet footer.
- The feedback surface rides the anonymous Bearer session and the shared `/v1` rate limiter.
