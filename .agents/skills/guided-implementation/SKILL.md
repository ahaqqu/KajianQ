---
name: guided-implementation
description: Use when implementing a plan. Read AGENTS.md for guardrails.
source: https://github.com/mattpocock/skills/blob/main/skills/engineering/implement/SKILL.md
synced: 2026-08-29
modified: true
---

# Guided Implementation

Use this skill when implementing a plan that is unclear, complex, or may affect architecture.

## Before writing code

1. Read the plan.
2. Read `AGENTS.md` for universal guardrails.
3. Read `docs/ARCHITECTURE.md` fully (including §14 Tooling) to verify alignment.
4. Review the domain checklist below for the areas your plan touches.
5. List implementation steps: contracts and test intent → implementation → test files → validation.
6. Highlight deviations. Do not start until the user confirms.

## Domain checklist

For each area the plan touches, verify compliance before writing code.

### Routes

- [ ] Valibot schema defined in `packages/contracts` (`@app/contracts`) before route implementation.
- [ ] Route uses `hono-openapi` on shared schemas.
- [ ] Route path under `/v1/`.
- [ ] OpenAPI spec regenerated from route definitions. Docs at `/docs` must not drift.

### Database schema

- [ ] Raw SQL migration written in `apps/api/migrations/`.
- [ ] Client migration written in `packages/local-first` (or `apps/web/src/lib/` if not yet moved).
- [ ] `SCHEMA_VERSION` bumped in `packages/local-first`.
- [ ] SQL uses only standard features — no SQLite-specific or D1-specific extensions.

### Sync logic

- [ ] Writes are optimistic into the custom LWW-element-set CRDT in `packages/local-first`. Tinybase is not used.
- [ ] Changes persist to IndexedDB in the same tick.
- [ ] Batched via `POST /v1/sync`. No polling loops.
- [ ] Retries use exponential backoff; permanent errors stop.
- [ ] Requests include `schemaVersion` and `clientVersion`.
- [ ] Merge logic is idempotent, commutative (including exact-timestamp ties), and propagates deletes.
- [ ] Multi-tab: single leader elected. Peers receive state via BroadcastChannel.
- [ ] Property tests added for idempotency, commutativity, associativity, delete-wins, and GC safety. See `.agents/skills/writing-tests/SKILL.md` (load it in the test phase, Phase boundary 2).

### Components

- [ ] Uses shadcn/ui primitives or follows the same custom pattern.
- [ ] All user-facing strings wrapped with i18n.
- [ ] Dates, numbers, and currency formatted via the `Intl` API.
- [ ] Tailwind CSS only. No runtime CSS-in-JS.

### Adapters

- [ ] Interface defined in `packages/infra/` first, before implementation.
- [ ] Adapter injected via env vars. Business logic never imports Cloudflare-specific types.
- [ ] Business logic accesses adapters through the interface — never through `env.*` directly.

### Payments

- [ ] Uses the Payments adapter interface. Provider APIs never called directly.
- [ ] Webhook handlers verify signatures before JSON parsing (raw-body verification).
- [ ] Webhook handlers are idempotent (same payload twice = same state as once).
- [ ] Premium features gated by ConfigStore entitlement checks at the edge, not client-side.

### Security

- [ ] Valibot validates every external input boundary.
- [ ] Secrets injected via `wrangler secret` — never committed.
- [ ] `secure-headers` middleware applied; CORS locked to known origins.

### Testing

- [ ] Unit tests (Vitest) for all business logic, schemas, store queries.
- [ ] Property tests (fast-check) for sync merge, client migrations, webhook idempotency.
- [ ] BDD tests (Playwright-BDD) for user-facing flows, offline-to-online sync.
- [ ] Coverage above 80%. See `.agents/skills/writing-tests/SKILL.md` for patterns (load it in the test phase, Phase boundary 2).

## KajianQ/DARS domain checklist

This monorepo also hosts the DARS engine (`packages/`) and the KajianQ domain pack (`packages/kajianq-domain`). When the plan touches DARS stages, retrieval, generation, ingestion, or evaluation, verify these in addition to the checklist above:

- **Locate the seam.** Pipeline stage (`Router`/`Retriever`/`Assembler`/`Generator`/`Reviewer`), `Provider`, `RagStore`, or `ObjectStore`. Implement behind it; if no seam exists, add the interface first, then the implementation, then the wiring. Full seam map and hard rules: `.agents/skills/dars-pluggability/SKILL.md`.
- **Stage wiring through the runner.** Stages are wired via the `runPipeline` runner and receive a `RunContext` (per-run config + `dispose?()`); the runner is the single trace collection point. Never wire a stage ad hoc or hand-assemble a trace — stages append `llm_call`/`refusal`/`review` events through `RunContext.record` (ADR-0021).
- **Trace every LLM call.** Model identity, tokens, latency, computed cost attach to the trace of the answer/run that triggered it. Trace/TraceEvent/CostRecord shapes come from `packages/contracts`; refusal/suppression events are recorded with reason and stage, never silently swallowed. Checklist: `.agents/skills/kajianq-traceability/SKILL.md`.
- **Per-stage models from config only.** Model choice per stage comes from `model_configs` config; no vendor or model names in engine or app code outside `packages/infra` Provider adapters.
- **Batch jobs produce reports.** Ingestion, eval, glossary build, narrator resolution runs produce ingestion/eval reports (counts, sampled-review scores, quarantine count, cost) — stored and citable, never skipped.
- **Respect go/no-go gates.** E.g. the embedding benchmark gate (#9) decides the retrieval posture before Kitab-scale ingestion starts. Check `adr/` and `SPECS.md` §7 for the gates your ticket touches.

### Pre-PR verification (KajianQ-specific)

Before opening the PR, run the Quick review scans from `.agents/skills/dars-pluggability/SKILL.md` (domain leakage, vendor names, direct SQL) and verify:

- [ ] Any new LLM call records model/tokens/cost to a trace.
- [ ] Any new persisted answer path writes a trace record the UI can render.
- [ ] Vocabulary matches `CONTEXT.md`; new domain terms added to `CONTEXT.md` in this PR.
- [ ] New ADRs added for hard-to-reverse decisions; PR description cites the issue + relevant ADRs.
- [ ] `NOTICES/DATASETS.md` updated when a dataset or corpus resource is touched.
- [ ] Touched `SPECS.md` sections updated in the same PR (architecture §3, data layer §3.5/§4, cost §5, plan §7, product scope §2); new ADR row in its §8 Record of Decisions.
- [ ] Golden Set traps added where the ticket demands them (new refusal case, trap question, or validator).

## During implementation

- Write contracts (Valibot schemas, types) before implementation.
- Test intent ships with the contracts: name the cases before code exists, per
  `docs/ARCHITECTURE.md` §10 ("contracts, types, and tests exist before
  code"). What defers to the test phase (Phase boundary 2) is the
  `writing-tests` skill load and the authoring of the test files — the
  artifacts still obey §10.
- When deviating from the plan, pause and ask for approval.
- When touching architecture, pause and ask for approval.
- Checkpoint commit at every test-green point (see below) — never batch all commits to the end.

## Phase boundaries

A run billed per request at its current context size gets expensive fast as the
context grows, and a run killed by a rate limit loses everything not yet
committed. An implementer run is therefore a sequence of explicit phases —
**implement → handoff → test loop → report** — and each boundary below is
mandatory, not advisory:

1. **Implement phase.** One-pass reads; do not re-read files you already hold,
   and trim command output as you go. Checkpoint commit as soon as any gate
   passes locally (typecheck, lint, a single test file), not only the full
   suite.
2. **Handoff boundary — before the test-iteration phase.** The exploration and
   writing you did to produce the change is dead weight for iterating on test
   failures. Before the first full test iteration, hand the verification loop
   (run gates, read failures, patch, rerun) to a fresh scoped context that
   carries only the failing output and the code under test; compaction, where
   the harness provides it, is an equivalent fallback. This boundary is also
   where the `writing-tests` skill load belongs — the test-phase context loads
   it there, with code already written, not the implement phase.
3. **Test loop.** Iterate to green in the lean context. Commit at every
   test-green point so a kill loses nothing but the current request.
4. **Report/review boundary — after review, before addressing feedback.**
   Address review findings in a fresh context (a new scoped subagent;
   compaction, where the harness provides it, is equivalent) that carries the
   findings and the relevant diff — not the whole implementation transcript.

## After implementation

- Run the project CI gate locally: `bun run check && bun run test && bun run size-limit`. See `docs/ARCHITECTURE.md` §14 for tooling.
- Verify against `AGENTS.md` Definition of Done.
- Report what was implemented and what changed from the plan.
- **Handoff:** in the test phase (Phase boundary 2), the fresh scoped context
  loads `writing-tests` to add any missing unit, property, and BDD coverage.
  After tests pass with >80% coverage, load `pr-creation` to create the pull
  request.
