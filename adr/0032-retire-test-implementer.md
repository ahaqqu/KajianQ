# ADR-0032 — Retire the `test-implementer` role on `model:high` tickets

**Status:** Accepted (2026-09-08).  
**Context:** Issue #? (simplify high-reasoning implementation flow).  
**Amends:** Manager skill §1 dispatch decision; senior-implementer.md §Test phase handoff; role registry README.

## Problem

The `model:high` flow split implementation and test authorship between `senior-implementer` and `test-implementer`. In practice this did not work: the test brief was often too thin, the handoff burned context and time, and the second role lacked the implementation context needed to write meaningful adversarial tests. The original intent — that a separate author would resist weakening assertions — was not realized.

## Decision

1. **Delete the `test-implementer` role.** Remove `test-implementer.md` and all references in skills and the role registry.
2. **Senior-implementer owns tests too.** On `model:high` tickets, the senior writes core code and the test suite in one run.
3. **Preserve the anti-bias rule by process, not role split.** The senior must:
   - Write the invariant statement before code.
   - Name adversarial/trap cases in the test intent.
   - Treat a failing test as "fix the implementation or report a suspected bug" — never weaken an assertion to make it pass.
   - Use the phase-boundary discipline: a fresh scoped context may run the test loop, but it remains the senior role (or the same senior model checkpointed).
4. **No test brief handoff artifact.** The senior reports the invariant, the evidence, and anything the reviewer should scrutinize — not a separate test brief for another role.

## Consequences

- One less role and one less dispatch per `model:high` ticket.
- The senior carries implementation context into test design, so traps are better informed.
- We lose the _separate author_ safeguard. We compensate by tightening the senior's own rules and by reviewer scrutiny of the invariant evidence.
- CI expectation: the senior's PR is green before review, including tests.

## Alternatives considered

- **Fresh senior context for tests.** Rejected: still a handoff and still the same model; the real cost is coordination overhead, not author identity.
- **Keep test-implementer but require stronger briefs.** Rejected: the owner observed that the overhead was structural, not a brief-quality problem.

## Evidence of acceptance

- `test-implementer.md` deleted; senior-implementer.md no longer references it; manager skill dispatch table removes A′.
