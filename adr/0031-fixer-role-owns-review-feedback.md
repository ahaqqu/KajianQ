# ADR-0031 — Review feedback is owned by a dedicated fixer role

**Status:** Accepted (2026-09-08).  
**Context:** Issue #? (review latency and feedback quality).  
**Amends:** Manager skill workflow (step 4 "Relay findings to A").

## Problem

Routing thermos review findings back to the original implementer for fix has been slow and low-quality in practice. The implementer is context-saturated from the implementation run, is biased toward its own design, and tends to produce shallow fixes or re-litigate items. The manager's current rule is to resume the same implementer; this preserves context but also preserves blind spots.

## Decision

1. **Introduce a `fixer` role** (`fixer.md`). After the reviewer posts itemized findings, the manager dispatches the `fixer` to own the response.
2. **The fixer is independent.** It is not the original implementer. It reads the PR, the review comments, and the relevant diff in a fresh context.
3. **The fixer dispositions and fixes.** For each item:
   - Post a threaded reply on the original review comment: `accept` or `reject` plus one-sentence reasoning.
   - Apply accepted fixes.
   - Keep CI green.
4. **Rejected items require evidence.** If the fixer rejects a High-priority finding, it must cite a file:line mechanism or request assistant-manager fact-finding. The manager adjudicates.
5. **Worktree handoff.** The fixer works in the same PR branch. It either reattaches the original implementer's worktree (`/tmp/wt-<branch>`) or adds its own fresh worktree from the existing branch. The manager owns cleanup after merge/close, per the existing isolation rule.

## Consequences

- Review feedback gets a fresh pair of eyes with no implementation sunk cost.
- The original implementer is freed to start the next task sooner.
- The fixer may need extra context on _why_ a change was made. It is responsible for reading commit messages and the PR description; the manager can dispatch the assistant-manager if history is unclear.
- Role-separated GitHub identities (ADR-0025) now include `fixer`.

## Alternatives considered

- **Same implementer, stricter fresh-context rule.** Rejected: it still keeps the same author bias and model/history noise.
- **Reviewer applies trivial fixes.** Rejected: it collapses the review/implementation separation that makes thermos findings credible.

## Evidence of acceptance

- `fixer.md` exists; manager skill step 4 references `fixer` instead of original implementer.
