---
name: pr-creation
description: Use when creating a pull request. Validate against AGENTS.md Definition of Done.
source: project
---

# PR Creation

Use this skill when creating a pull request.

## Before creating the PR

1. Check the branch at the start of the turn (`git branch --show-current`); create a branch from `main` if task work is not already on one. Never commit task work directly on `main`.
2. Run the project CI gates locally: `bun run check`, `bun run lint`, `bun run test`, `bun run boundary`, `bun run agentic-limits`, `bun run openapi:check`, `bun run size-limit`. Fix failures until green.
3. Read `AGENTS.md`. Validate code against the Definition of Done.
4. Do not read `docs/ARCHITECTURE.md`.
5. If this PR addresses one or more GitHub issues, gather their numbers/URLs from the current branch context. You will need them for the PR description.

## Validation

Follow the Definition of Done in `AGENTS.md`:

- All CI gates green.
- Contracts written before implementation.
- API or UI changes: BDD tests added.
- Schema changes: raw SQL migration in the owning package's `migrations/` dir (engine `packages/infra/migrations`, product API `apps/api/migrations`, concept graph `packages/kajianq-domain/migrations`), applied via the `db:*` scripts; no client-side migrations (client state is TanStack Query over `/v1`).
- New routes: Valibot contract in `packages/contracts` (`@app/contracts`) + `hono-openapi` route definition; `/openapi.json` regenerates from the same definitions.
- No new paid dependency in the critical path.
- Nothing sensitive in the diff.
- Architectural changes documented in PR description.
- Human-review gate stated if triggered: destructive migration, new dependency, auth change.

## Layer & project separation

KajianQ and DARS are separate concerns in one monorepo, and every change belongs to exactly one layer. Identify both before writing the PR description — they determine the scope tag and the description sections.

**Project separation:**

- **DARS** (engine) — `packages/rag-core`, `rag-ingest`, `eval`, `contracts`, `infra`, `rate`, `hardening`. Domain-agnostic, vendor-neutral, no Islamic-domain logic, no direct DB access outside the `RagStore` adapter and migrations. A change here merges toward a future standalone DARS repo.
- **KajianQ** (product) — `apps/web`, `apps/api`, `packages/kajianq-domain`. Domain vocabulary, prompts, corpus ingestion, and UI live here.

A PR that touches both must state the split explicitly (e.g. engine change in `rag-core` + its product wiring in `apps/api`). If a "DARS" change needs an Islamic-domain name, it is misplaced — move the concept to the domain pack.

**Layer separation (use these as the PR description's change sections):**

| Layer              | What belongs here                                                                                                                                 | Where it lives                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Supporting code    | Contracts, schemas, shared types, scripts, migrations, tooling config — code that other layers import but that does not execute on a request path | `packages/contracts`, `scripts/`, `migrations/`, root config                                |
| Backend processing | Engine logic that runs when a request or batch is processed: pipeline stages, retrieval, generation, ingestion, eval, cost/trace accounting       | `packages/rag-core`, `rag-ingest`, `eval`, `kajianq-domain`, `apps/api` route/service logic |
| Backend runtime    | Deploy/dev/lifecycle tooling: Alchemy stack file, migrations runner, CI workflows, secret binding, deploy scripts                                 | `apps/api/alchemy.run.ts`, `.github/workflows/`, deploy scripts                             |
| Frontend           | UI, client state, i18n, PWA — plain TypeScript, never `effect`                                                                                    | `apps/web`                                                                                  |

Report each layer the PR touches in its own description section (`None` for the rest) so a reviewer can check engine purity, trace discipline, and bundle budget per layer instead of untangling one mixed diff.

## PR title

```
<type>(<scope>): <short summary>
```

Type: `feat` · `fix` · `refactor` · `docs` · `chore`
Scope: the most specific layer/project segment touched — engine package name (e.g. `rag-core`, `infra`), product area (e.g. `api`, `web`, `kajianq-domain`), or `agentic` for skills/workflow tooling
Max 72 characters

## PR description

```markdown
## Summary

Concise summary of changes, not a file list. State the project split
(DARS engine vs KajianQ product) and the layers touched.

## Closes

Closes #123, closes #124. When the PR is merged, GitHub auto-closes these issues.

- Use the keyword `Closes` (or `Fixes` / `Resolves`) followed by the issue number, e.g. `Closes #123`.
- Repeat the keyword for every issue: a keyword binds only the first reference after it — `Closes #123, #124` auto-closes #123 and silently leaves #124 open (GitHub does not re-run closing keywords on a merged PR, so the skip is permanent).
- List every issue this PR fully resolves. Do not list issues that are only partially addressed — those need a comment, not auto-close.
- If this PR does not address a tracked issue, write `None`.

## Architecture

Architectural changes, or `None`.

## Supporting code

Contracts, schemas, shared types, migrations, scripts, tooling — or `None`.

## Backend processing

Engine/pipeline/API logic changes with test proof, or `None`.

## Backend runtime

Alchemy/deploy/CI/lifecycle tooling changes, or `None`.

## Frontend

UI/client changes with test proof, or `None`.

## Security Review

Security implications, or `None`.

## Performance Review

Performance implications, or `None`.

## Acceptance Criteria

Checklist from AGENTS.md Definition of Done.

## Documentation

Docs updated: `AGENTS.md` / `adr/`, or `None`.

## Limitations & Warnings

Any limitations, or `None`.
```

## Push authentication

- You SHOULD push over SSH (`git@github.com:owner/repo.git`) — HTTPS OAuth pushes that create or update `.github/workflows/` require the `workflow` scope; check `gh auth status` first.
- You MUST NOT fix push-auth failures by editing the global gh/git config; use SSH or repo-local `git config`.

## Rules

- You MUST NEVER merge your own PR. Submit for human review only.
- You MUST NOT create a PR with a dirty working tree.
- You MUST create a PR even for trivial changes.
- You MUST NEVER add a co-author to the PR description or commit messages, directly or via an author-email override.
- You MUST reference relevant GitHub issues in the PR description so they close automatically upon merge.
- PR titles/descriptions in English; create via `gh api --input` with a JSON payload file — never `gh pr edit --field body=…`.
