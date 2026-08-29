# AGENTS.md — Task guardrails for AI agents working on KajianQ & DARS

Read before any task, whatever your role — manager, implementer, reviewer, or assistant. This file states the guardrails every role must hold; the technical depth (seam maps, checklists, verification scans, pipeline contracts) lives in the skills referenced below — load the skill for the phase you are working in.

For philosophy and rationale, see `docs/ARCHITECTURE.md`. For the living architecture/plan spec, see `SPECS.md` — read the sections your task touches, and keep them true in the same PR (rule below).

## What this repo is

Two projects in one monorepo (ADR-0005):

- **DARS** (*Dynamic Automated RAG Solution*) — the generic, domain-agnostic RAG engine: workspace packages under `packages/` (`rag-core`, `rag-ingest`, `eval`, `contracts`, `infra`). When DARS matures it may live in its own repo (`github.com/ahaqqu/DARS`); until the second consumer exists, this file governs it here.
- **KajianQ** — the product: an Islamic classical-knowledge chatbot under `apps/` plus the domain pack `packages/kajianq-domain`.

**Read first, in this order:** `CONTEXT.md` (domain glossary — its vocabulary is normative: use defined terms exactly, never invent synonyms; new domain terms are added to `CONTEXT.md` in the same PR that introduces them) → `SPECS.md` (the sections your task touches) → the ADRs that touch your task → your GitHub issue's acceptance criteria (your definition of done).

## Universal guardrails

These apply to every role and every task. Each bullet names the skill that carries the full checklist — when the bullet binds your work, load that skill.

- **Pluggable by design** — every external dependency and every pipeline stage is replaceable by configuration first, and by code changes when deep customization is needed. Work behind the existing seams (`Provider`, `RagStore`, `ObjectStore`, the pipeline stage interfaces); if no seam exists and you need one, add the seam first. Checklist: `.agents/skills/dars-pluggability/SKILL.md`.
- **Traceable by design** — never hide the machinery (a hard product boundary, not a nice-to-have). Every LLM call records model identity, tokens, latency, and cost on the trace of the answer/run that triggered it; user-visible data structures come from persisted trace records. Checklist: `.agents/skills/kajianq-traceability/SKILL.md`.
- **Engine purity** — engine packages (`rag-core`, `rag-ingest`, `eval`, `contracts`, `infra`, `rate`, `hardening`) contain zero Islamic-domain logic, zero vendor or model names, and no direct database access (only the `RagStore` adapter and migrations touch SQL). Checklist: `dars-pluggability`.
- **Reuse** — shared, project-agnostic logic lives in a dedicated `packages/<name>` workspace package, never `apps/`. `packages/` is the template-sync merge path that forks inherit; `apps/` is the per-project composition root that each fork owns and customizes.
- **Data integrity** — never overwrite raw source data (`text_raw` and original exports are immutable; cleaning/translation writes new fields); re-runnable ingestion is idempotent; Matn and Sharh are never mixed in one chunk; disputed attributions are quarantined or labeled, never force-merged.
- **Cost discipline** — price is weighed in every model decision; model choice per stage comes from config (`model_configs`) only. Vendor allowlist and the paid-API amendment: ADR-0009.
- **Decisions** — hard-to-reverse, surprising, trade-off decisions get an ADR in `adr/` (numbered to continue the existing sequence) before or with the implementing PR. Never relitigate an accepted ADR in code comments; amend the ADR instead. Respect the go/no-go gates recorded in ADRs.
- **Living documents** — a PR that changes what `SPECS.md` describes (architecture §3, data layer §3.5/§4, cost §5, plan §7, product scope §2) updates those sections in the same PR, and any new ADR gets its row in the spec's §8 Record of Decisions. `INITIAL_IDEA.md` is frozen history — never update it.
- **Datasets** — update `NOTICES/DATASETS.md` when a dataset or corpus resource is touched.
- **Language** — technical docs and code in English; UI copy Indonesian-first (externalized `en`/`id`).

## The agentic workflow

For the recommended end-to-end pipeline and when to use each skill, invoke the `agentic-workflow` skill (`.agents/skills/agentic-workflow/SKILL.md`). It maps the design → spec → tickets → plan → implementation → tests → PR → review → ship sequence without duplicating each skill's content.

For autonomous, multi-agent orchestration of the implement → review → fix loop, invoke the `manager` skill (`.agents/skills/manager/SKILL.md`). It spawns role subagents (implementer, reviewer, assistant-manager), monitors until the PR is green, relays itemized review findings, and recommends next steps. Role models are configured in `.zcode/agents/` (see `.zcode/agents/README.md` for override order and other-harness adaptation).

## Prior to implementation

See `.agents/skills/grill-with-docs/SKILL.md` — sharpen designs through structured interview; produce ADRs and glossary.

See `.agents/skills/to-spec/SKILL.md` — turn the grilled design into a spec.

See `.agents/skills/to-tickets/SKILL.md` — break the spec into tracer-bullet tickets; it also assigns the model routing labels (see § Ticket model routing).

See `.agents/skills/plan-review/SKILL.md` — validate your plan against architecture before writing code.

## During implementation

See `.agents/skills/guided-implementation/SKILL.md` — the implementation checklist, including the KajianQ/DARS domain checklist: seams, trace discipline, ingestion rules, vocabulary/ADR/spec-currency duties, and the pre-PR verification scans.

See `.agents/skills/writing-tests/SKILL.md` — unit, property, BDD, and integration test patterns.

## After implementation

See `.agents/skills/pr-creation/SKILL.md` — validate against the Definition of Done and create the pull request.

See `.agents/skills/code-review/SKILL.md` — the single review entry point: philosophy and guardrail compliance plus the review-depth rule. Any PR that touches code is reviewed at thermos depth (mandatory — the two thermo passes, posted as itemized comments via `thermos-with-comments`); docs/skill-only changes may skip thermos. code-review never runs `thermos` directly.

See `.agents/skills/thermos-with-comments/SKILL.md` — the comment-posting arm of code-review's thermos depth (used by the manager's reviewer role): posts each finding as an itemized GitHub review comment (A1/B1/C1 IDs) plus a summary comment, so an implementer can accept, reject, or address findings individually by ID.

See `.agents/skills/ship/SKILL.md` — staging → tests → production → smoke tests.

## Troubleshooting

See `.agents/skills/diagnosing-bugs/SKILL.md` — tight feedback-loop-first debugging discipline.

## Ticket model routing

Tickets carry model routing labels applied by the `to-tickets` skill and consumed by the `manager` skill's dispatch decision — the manager consumes labels, never invents them:

- **`model:high`** — the ticket carries a correctness/trust invariant that fails silently (validators, trap questions, sample audits). Implement with a high-reasoning model; do not downgrade.
- **`model:plus-human`** — a human curation/verification gate holds an acceptance criterion (Principle Index, complete-works bibliographies, Golden Set trap design). Code alone never closes the ticket; the manager escalates to the owner instead of dispatching implementation.
- **No label** — default tier.

## Working agreements (from the owner — non-negotiable)

- **Check the branch at the start of every turn.** Before the first git write of each session turn, run `git branch --show-current` and switch to the intended PR branch if needed. The owner may change branches between prompts, but never mid-turn — one check per turn is enough. Never commit task work directly on `main`.
- Complete a task end-to-end with a PR created via the `pr-creation` skill, then hand it to the owner for review. **Never merge a PR unless the owner explicitly approves merging it.**
- Orchestrators instruct spawned subagents explicitly about PR creation and CI-green expectations, supervise and monitor their work, and report back when they finish.
- PR titles/descriptions in English; create via `gh api --input` with a JSON payload file — never `gh pr edit --field body=…`.
- Do not close or modify the spec issues (#1, #27). Tick ticket checkboxes via `gh api --input` PATCH.
- Dependency guardrails (ADR-0009 amendment): paid LLM/embedding APIs **are** accepted in the critical path, but price is weighed in every model decision, free tiers are used only where quality allows, cost is traced per query, personal data never routes through free tiers, adapters stay in `packages/infra`, business logic never touches `env.*` directly, and no secrets are committed.

## Definition of Done

- [ ] All CI gates green: `bun run check`, `bun run test`, `bun run boundary`, `bun run size-limit`, `bun run agentic-limits`, `bun run truth`, `bun run openapi:check`, `bun run template-gate`, plus security scans.
- [ ] Domain boundary holds: the verification scans in `.agents/skills/dars-pluggability/SKILL.md` return only allowed hits.
- [ ] Traceability holds: any new LLM call records model/tokens/cost to a trace; any new persisted answer path writes a trace record the UI can render. Checklist: `.agents/skills/kajianq-traceability/SKILL.md`.
- [ ] Contracts written before implementation; pipeline wiring goes through the `runPipeline` runner — never hand-assembled traces or ad hoc stage wiring (ADR-0021).
- [ ] API or UI changes: BDD tests added covering the user-facing flow.
- [ ] Schema changes: migration through the `RagStore` adapter's conventions; no direct DB client imports outside the adapter and migrations.
- [ ] No new paid dependency without a recorded decision (config + ADR if surprising).
- [ ] No dependency without an importer; no adapter without a production caller; every gate blocking; every doc claim has code.
- [ ] Nothing sensitive in the diff.
- [ ] Vocabulary matches `CONTEXT.md`; new ADRs and Golden Set traps added where the task demands.
- [ ] Spec currency: touched `SPECS.md` sections updated in the same PR; new ADR row in its §8 Record of Decisions.
- [ ] Architectural changes documented in the PR description.
