# ADR-0033 — Reviewer absorbs both thermo passes to respect concurrency limits

**Status:** Accepted (2026-09-08).  
**Context:** Issue #? (provider limits at most 3 concurrent sessions).  
**Amends:** `code-review` skill thermos depth; `thermos-with-comments` skill; `reviewer.md`; manager skill reviewer dispatch; DSH adapter.

## Problem

## Decision

1. **No sub-reviewers.** The `reviewer` role runs the security/correctness pass and the maintainability pass itself, sequentially or in one larger context.
2. **Inline the prompts.** The reviewer loads the standards from `thermo-nuclear-review/SKILL.md` and `thermo-nuclear-code-quality-review/SKILL.md` directly, then produces one unified itemized report with IDs `A1…`, `B1…`, `C1…`.
3. **Keep the posting contract unchanged.** Itemized review comments, stable IDs, summary comment, and verification all remain per `thermos-with-comments`.
4. **Concurrency budget.** With this change, the manager loop uses at most two concurrent sessions during review (fixer may still run separately), fitting the three-session cap.

## Consequences

- Reduced concurrency pressure and fewer scheduling stalls.
- The reviewer request may become larger because it holds two prompt sets and a bigger synthesis task. We accept this trade-off because token cost is cheaper than concurrency deadlock.
- The two passes can be run sequentially to keep per-request size reasonable, or the reviewer may choose to run them together if the diff is small. The skill gives the reviewer that discretion.
- DSH adapter loses its fallback inline path for missing subagent types; the single-reviewer path becomes the only path.

## Alternatives considered

- **Global allocator that serializes when 3 sessions are in use.** Rejected: adds coordination complexity and still blocks; the provider limit is hard.
- **Scope thermos to skip it for small PRs.** Rejected: `code-review` already mandates thermos for any runtime-code change; relaxing that weakens guardrail enforcement.

## Related simplifications

This ADR also removes the manager skill's "Efficiency watchdog" section. Cost supervision is now delegated to the harness/provider telemetry and budgets; the manager's remaining supervision duties are the stall rule, context-budget handoffs, and one-shot CI verification.

## Evidence of acceptance

- Sub-reviewer role files deleted; reviewer.md describes a single reviewer doing both passes; manager skill no longer mentions spawning sub-reviewers.
- Manager skill no longer contains a dedicated "Efficiency watchdog" section.
