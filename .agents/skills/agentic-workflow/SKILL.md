---
name: agentic-workflow
description: Orchestration map for the recommended agent-driven development pipeline. User-invoked only — type "agentic workflow".
disable-model-invocation: true
---

# Agentic Workflow

Use this skill when you want the high-level map for developing a feature in this repo from idea to production. It only points to other skills; load the specific skill for each phase when you're ready to do that phase's work.

## The pipeline

```
grill-with-docs → to-spec → to-tickets → plan-review
  → guided-implementation → writing-tests → pr-creation
  → code-review → ship
```

For bug fixes, start with `diagnosing-bugs` before any implementation phase, then resume at the appropriate point (often `guided-implementation` or `writing-tests`).

## When to skip / loop

| Situation | Adjustment |
|---|---|
| Trivial fix (typo, one-liner) | Skip `grill-with-docs`, `to-spec`, `to-tickets`, `plan-review`. Go straight to `guided-implementation` or `pr-creation`. |
| Design already approved / spec exists | Skip `grill-with-docs` and `to-spec`. Start at `to-tickets` or `plan-review`. |
| Hot bug in production | Start at `diagnosing-bugs`. Skip long spec work; produce a minimal repro + regression test, then PR. |
| Existing ADRs cover the area | Use the glossary and ADRs from `grill-with-docs`; you may not need a new ADR. |

## Phase-by-phase entry point

1. **Sharpen the design** — load `.agents/skills/grill-with-docs/SKILL.md`.
   - It orchestrates `.agents/skills/grilling/SKILL.md` (the interview discipline) and `.agents/skills/domain-modeling/SKILL.md` (the glossary and ADR capture).
   - Output: domain glossary in `docs/GLOSSARY.md` + ADRs in `adr/`.

2. **Write the spec** — load `.agents/skills/to-spec/SKILL.md`.
   - Output: spec in the configured tracker (defaults to `.scratch/<feature-slug>/spec.md`).

3. **Break into tickets** — load `.agents/skills/to-tickets/SKILL.md`.
   - Output: tracer-bullet tickets with blocking edges.

4. **Validate the plan** — load `.agents/skills/plan-review/SKILL.md`.
   - Check every principle in `docs/ARCHITECTURE.md` before writing code.

5. **Implement** — load `.agents/skills/guided-implementation/SKILL.md`.
   - Follow the domain checklist for routes, database schema, sync, components, adapters, payments.
   - Stop and ask for approval on architectural deviations.

6. **Write tests** — load `.agents/skills/writing-tests/SKILL.md`.
   - Unit (Vitest), property (fast-check), BDD (Playwright-BDD).
   - Coverage must stay above 80%.

7. **Create the PR** — load `.agents/skills/pr-creation/SKILL.md`.
   - Validate against `AGENTS.md` Definition of Done before opening.

8. **Review the PR** — load `.agents/skills/code-review/SKILL.md`.
   - For large refactors / core modules, also load `.agents/skills/thermo-nuclear-code-quality-review/SKILL.md`.

9. **Ship** — load `.agents/skills/ship/SKILL.md`.
   - Staging → BDD → DAST → fuzz → production → smoke tests → cleanup.

## Always-in-force rules

- Read `AGENTS.md` before touching business logic.
- Read `docs/ARCHITECTURE.md` fully when the change may affect architecture.
- Read `CONTEXT.md` to understand the current Notes vertical slice and what is already built.
- For grilling or domain modeling, load `grill-with-docs`; for focused terminology or ADR work, load `domain-modeling` directly.
- Run `bun run check && bun run test && bun run size-limit` before any PR.
- Run the full CI gate locally before declaring a workstream done.

## Completion criterion

This skill is done when you know which phase to start and which specific skill to load next.
