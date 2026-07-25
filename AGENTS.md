# AGENTS.md

Task guardrails for AI agents. Read before any task. For philosophy and rationale, see `docs/ARCHITECTURE.md`.

## Universal

These apply regardless of whether you are planning, implementing, reviewing, or debugging:

- When touching business logic, you MUST use adapters in `packages/infra`. You MUST NEVER access `env.*` bindings directly.
- When adding a dependency, you MUST verify free-tier compatibility. You MUST NEVER add paid services to the critical path.
- When adding user-facing strings, you MUST externalize for `en` and `id`. You MUST NEVER hardcode copy.
- When logging, you MUST use the Logger adapter with structured JSON. You MUST NEVER use `console.log`.
- When validating input, you MUST use Zod at every external boundary.
- When handling secrets, you MUST use `wrangler secret`. You MUST NEVER commit secrets to the repo.
- Files are 300 lines or fewer with 5 or fewer direct dependencies.

## Prior to implementation

See `.agents/skills/grill-with-docs/SKILL.md` — sharpen designs through structured interview; produce ADRs and glossary.

See `.agents/skills/plan-review/SKILL.md` — validate your plan against architecture before writing code.

## During implementation

See `.agents/skills/guided-implementation/SKILL.md` — contains the full domain-specific checklist for routes, database schema, sync, components, adapters, and payments. Load it when writing code. The checklist covers:

- Routes: `/v1/` prefix, `@hono/zod-openapi`, OpenAPI spec regeneration
- Database: Drizzle migrations, client migrations, `SCHEMA_VERSION` bumps
- Sync: Tinybase MergeableStore CRDT, IndexedDB persistence, batching, multi-tab leader election
- Components: shadcn/ui primitives, i18n wrapping, `Intl` API, Tailwind only
- Adapters: interface-first in `packages/infra/`, env var injection
- Payments: adapter interface only, webhook signature verification, idempotency

See `.agents/skills/writing-tests/SKILL.md` — unit, property, BDD, and integration test patterns.

## After implementation

See `.agents/skills/code-review/SKILL.md` — verify changes against philosophy and guardrails before creating a PR.

See `.agents/skills/ship/SKILL.md` — staging → tests → production → smoke tests.

## Troubleshooting

See `.agents/skills/diagnosing-bugs/SKILL.md` — tight feedback-loop-first debugging discipline.

## Definition of Done

- [ ] All CI gates green: `vp check`, `vp test`, coverage > 80%, `size-limit`, security scans.
- [ ] Contracts written before implementation.
- [ ] API or UI changes: BDD tests added covering the user-facing flow.
- [ ] Schema changes: server migration + client migration + `SCHEMA_VERSION` bump.
- [ ] New routes: zod-openapi contract defined; docs regenerate cleanly.
- [ ] No new paid dependency in the critical path.
- [ ] Nothing sensitive in the diff.
- [ ] Architectural changes documented in PR description.
