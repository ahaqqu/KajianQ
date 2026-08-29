# AGENTS.md

Task guardrails for AI agents. Read before any task. For philosophy and rationale, see `docs/ARCHITECTURE.md`.

## Universal

These apply regardless of whether you are planning, implementing, reviewing, or debugging:

- When touching business logic, you MUST use adapters in `packages/infra`. You MUST NEVER access `env.*` bindings directly.
- When planning or implementing, you MUST decide whether a module is reusable across forked projects. Shared, project-agnostic logic (adapters, algorithms, protocols) MUST live in a dedicated `packages/<name>` workspace package (e.g. `@app/rate`), never in `apps/` — `apps/` is the per-project composition root (bindings, entrypoints, deploy config) and the part forks own and customize.
- When adding a dependency, you MUST verify free-tier compatibility. You MUST NEVER add paid services to the critical path.
- When adding user-facing strings, you MUST externalize for `en` and `id`. You MUST NEVER hardcode copy.
- When logging, you MUST use the Logger adapter with structured JSON. You MUST NEVER use `console.log`.
- When validating input, you MUST use Valibot schemas from `packages/contracts` (`@app/contracts`) at every external boundary.
- When handling secrets, you MUST use `wrangler secret`. You MUST NEVER commit secrets to the repo.
- Files are 300 lines or fewer with 5 or fewer direct dependencies.

## Template sync

Forked projects sync template updates via `scripts/template-sync/cli.mjs`; `template-sync.json` is the ownership map and the single source of truth for which paths are template-owned. `overwrite` paths (listed in `template-sync.json`) are template-owned — never edit them in a project; `bun run template-gate` fails on drift. `merge` paths (`apps/`, `packages/`, `package.json`, `README.md`, `CONTEXT.md`) inherit changes — extend project code there. Unlisted paths are project-owned. Because `packages/` is a merge path and `apps/` glue is fork-customized, keeping reusable code in `packages/` is what lets forks inherit template improvements (e.g. `@app/rate`) without copy-pasting.

## Payments

This template ships **without** payments (see CONTEXT.md); when a consuming project adds payments, start from the `.agents/skills/payment-integration/SKILL.md` skill, which provides the Payments adapter interface in `packages/infra`.

## The agentic workflow

For the recommended end-to-end pipeline and when to use each skill, invoke the `agentic-workflow` skill (`agentic-workflow/SKILL.md`). It maps the design → spec → tickets → plan → implementation → tests → PR → review → ship sequence without duplicating each skill's content.

For autonomous, multi-agent orchestration of the implement → review → fix loop, invoke the `manager` skill (`manager/SKILL.md`). It spawns role subagents (implementer, reviewer, assistant-manager), monitors until the PR is green, relays itemized review findings, and recommends next steps. Role models are configured in `.zcode/agents/` (see `.zcode/agents/README.md` for override order and DeepSeek/other-harness adaptation).

## Skill authoring

When creating or editing a skill (or this file), load `.agents/skills/writing-for-agents/SKILL.md` — the craft reference; its `SKILL-MECHANICS.md` covers invocation and router skills, and `TIERS.md` this template's conventions: skills are **entry** (indexed here) or **library** (reached only through a parent — library header line, trigger-free description, never indexed); vendored skill bodies stay byte-faithful; every `SKILL.md` frontmatter carries `source` / `upstream` / `modified` / `synced` provenance.

## Prior to implementation

See `.agents/skills/grill-with-docs/SKILL.md` — sharpen designs through structured interview; produce ADRs and glossary.

See `.agents/skills/to-spec/SKILL.md` — turn the grilled design into a spec.

See `.agents/skills/to-tickets/SKILL.md` — break the spec into tracer-bullet tickets.

See `.agents/skills/plan-review/SKILL.md` — validate your plan against architecture before writing code.

## During implementation

See `.agents/skills/guided-implementation/SKILL.md` — domain checklist for routes, database schema, sync, components, adapters, and payments.

See `.agents/skills/writing-tests/SKILL.md` — unit, property, BDD, and integration test patterns.

## After implementation

See `.agents/skills/pr-creation/SKILL.md` — validate against the Definition of Done and create the pull request.

See `.agents/skills/code-review/SKILL.md` — the single review entry point: philosophy and guardrail compliance plus the review-depth rule. Any PR that touches code is reviewed at thermos depth (mandatory — the two thermo passes, posted as itemized comments via `thermos-with-comments`, so an implementer can accept, reject, or address findings individually by ID); docs/skill-only changes may skip thermos. code-review never runs `thermos` directly.

See `.agents/skills/ship/SKILL.md` — staging → tests → production → smoke tests.

## Troubleshooting

See `.agents/skills/diagnosing-bugs/SKILL.md` — tight feedback-loop-first debugging discipline.

## Definition of Done

- [ ] All CI gates green: `bun run check`, `bun run test` (coverage > 80%), `bun run size-limit`, `bun run agentic-limits`, `bun run truth`, `bun run template-gate`, security scans.
- [ ] Contracts written before implementation.
- [ ] API or UI changes: BDD tests added covering the user-facing flow.
- [ ] Schema changes: server migration + client migration + `SCHEMA_VERSION` bump.
- [ ] New routes: Valibot contract in `packages/contracts` + hono-openapi route definition; `/openapi.json` regenerates from the same definitions.
- [ ] No new paid dependency in the critical path.
- [ ] No dependency without an importer; no adapter without a production caller; every gate blocking; every doc claim has code.
- [ ] Nothing sensitive in the diff.
- [ ] Architectural changes documented in PR description.
