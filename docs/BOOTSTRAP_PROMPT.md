# Bootstrap Prompt

Use this prompt to create a new project from the `agentic-project-template`.

## Single-shot prompt

```text
Create a new project called "<project-name>" by forking/cloning the
agentic-project-template repository. Then:

1. Replace template identifiers with the new project name:
   - `apps/api/wrangler.toml`: `name`, `database_name`, `bucket_name`,
     `bucket_name`, `ALLOWED_ORIGINS`, and staging equivalents.
   - `package.json`: `name` field.
   - `README.md`: project title, purpose, and setup examples.
   - `AGENTS.md`, `CONTEXT.md`, `docs/ARCHITECTURE.md`: any
     project-specific references to "agentic-template" or "Notes".

2. Provision Cloudflare resources on the free tier:
   - Create a D1 database for production and one for staging.
   - Create an R2 bucket for production and one for staging.
   - Update `database_id` values in `apps/api/wrangler.toml` with real IDs.

3. Configure secrets and environment:
   - Copy `.env.example` to `.env` and fill `CLOUDFLARE_ACCOUNT_ID` and
     `CLOUDFLARE_API_TOKEN` (needs Workers Scripts:Edit, D1:Edit, R2:Edit).
   - Remove the example Sentry lines unless a DSN will be configured.

4. Run the local verification pipeline:
   - `bun install --frozen-lockfile`
   - `bun run check`
   - `bun run test`
   - `bun run db:migrate:local`
   - `bun run build`
   - `bun run size-limit`
   - `bun run agentic-limits`
   - `bun run truth`

5. Run E2E smoke once local resources exist:
   - `bun run build`
   - `bun run e2e`

6. Clean up template-only artifacts that do not apply to the new product:
   - Remove sample Notes routes, components, contracts, migrations, and
     tests only after the replacement vertical slice is ready.
   - Keep the CI workflows, adapter patterns, and agent skills intact.

7. Initialize a fresh git repository (or rebase onto a clean history),
   push to the new remote, and confirm both `CI` and `E2E` GitHub Actions
   pass on the default branch before declaring bootstrap complete.
```

## Follow-up prompts by phase

Use these after the initial bootstrap to align the team and agents.

### Product discovery

```text
We are building <project-name> for <target users>. The core value is
<one-sentence value>. The first shipped milestone must demonstrate
<end-to-end user flow>. Use the grill-with-docs skill to interview me,
produce ADRs for the two highest-risk decisions, and update the glossary
in docs/GLOSSARY.md.
```

### Spec and tickets

```text
Turn the grilled design for <milestone> into a spec in docs/SPEC.md, then
break it into tracer-bullet tickets with blocking edges using the
to-tickets skill. Each ticket must include a BDD-style acceptance check.
```

### Implementation

```text
Implement ticket <ticket-id> following the guided-implementation skill.
Respect AGENTS.md guardrails: adapters only, Valibot contracts at every
external boundary, externalized en/id strings, structured JSON logging,
file length under 300 lines, and ≤5 direct imports. Add tests before
or with the code.
```

### Validation and shipping

```text
Run the full gate locally: bun run check, test, build, size-limit,
agentic-limits, truth, and e2e. Then use the pr-creation skill to open a
PR that passes CI and E2E, and use the ship skill for staging →
production deployment with smoke tests.
```

## Checklist for the first PR

- [ ] Project name replaced in `wrangler.toml`, `package.json`, and docs.
- [ ] Real Cloudflare D1 and R2 IDs configured for production and staging.
- [ ] `.env` created locally and never committed.
- [ ] `bun run check` passes.
- [ ] `bun run test` passes with coverage > 80%.
- [ ] `bun run build` passes.
- [ ] `bun run size-limit` passes.
- [ ] `bun run agentic-limits` passes.
- [ ] `bun run truth` passes.
- [ ] `bun run e2e` passes.
- [ ] CI and E2E workflows are green on the default branch.
