# AGENTS.md — Rules for AI agents working on KajianQ & DARS

This repository hosts two projects in one monorepo (ADR-0005):

- **DARS** (*Dynamic Automated RAG Solution*) — the generic, domain-agnostic RAG engine: workspace packages under `packages/` (`rag-core`, `rag-ingest`, `eval`, `contracts`, `infra`). When DARS matures it may live in its own repo (`github.com/ahaqqu/DARS`); until the second consumer exists, this file governs it here.
- **KajianQ** — the product: an Islamic classical-knowledge chatbot under `apps/` plus the domain pack `packages/kajianq-domain`.

Most implementation in both projects is done by AI agents. This file is the **standing instruction set** for every agent session. It exists so that a principle stated once — *pluggable and traceable by design* — is enforced in every ticket, without the user having to repeat it.

**Read first, in this order:** `CONTEXT.md` (domain glossary — never invent synonyms for defined terms) → the ADRs that touch your ticket → your GitHub issue's acceptance criteria (your definition of done).

---

## 1. The two design principles

### 1.1 Pluggable by design

Every external dependency and every pipeline stage is replaceable **by configuration, never by code edit**.

- **Pipeline stages.** The DARS pipeline is typed interfaces in `rag-core`: `Router`, `Retriever`, `Assembler`, `Generator`, `Reviewer`. Implementations live behind those interfaces; stages communicate **in-process** (modular monolith — no HTTP between stages).
- **Vendors.** All LLM/embedding calls go through the `Provider` interface (`generate` / `stream` / `embed`). Vendor allowlist: **Gemini, Kimi, DeepSeek, Qwen only** (ADR-0009). Model choice per stage comes from config (`model_configs`) only.
- **Persistence.** All database access goes through the `RagStore` adapter in `packages/infra` (ADR-0008). Blob storage goes through the `ObjectStore` adapter (R2 today).

### 1.2 Traceable by design

**Never hide the machinery** — this is a hard product boundary (spec §1.5), not a nice-to-have.

- Every answer persists a full `answer_traces` record: router intent, sub-queries (including Query Expansion candidates per ADR-0014), retrieved chunks with scores (`rrf_score`, `rank_dense`, `rank_sparse`), routing filters, model identity, tokens in/out, latency, computed cost.
- Every batch operation (ingestion, eval, glossary build, narrator resolution) produces an **ingestion/eval report**: counts, sampled-review scores, quarantine count, cost.
- Traceability extends to provenance: `text_raw` is always preserved (R2 + DB), every Lemma ties back to evidence ayah pairs (`lemma_evidence`), disputed attributions are excluded or labeled — never silently ingested.

---

## 2. Non-negotiable rules (violations are PR-blocking)

### Domain boundary

1. **Engine packages (`rag-core`, `rag-ingest`, `eval`, `contracts`, `infra`) contain ZERO Islamic-domain logic.** No madhhab enums, grade vocabulary, principle tags, citation formats, Arabic-specific handling, or religious prompt text. All of that lives in `kajianq-domain` and `apps/`. A boundary test/lint rule enforces this (ticket #3) — if you need a domain concept in an engine package, you are building the wrong shape: parameterize it instead.
2. **No vendor or model names in engine code.** "Qwen", "Gemini", model IDs, and prices appear only in `model_configs` config and the Provider adapter implementations in `packages/infra`. Swapping the generator must be a config edit, not a PR against `rag-core`.
3. **No direct SQL outside the `RagStore` adapter.** Engine and app code never import a database client. Migrations may contain SQL; nothing else does.

### Traceability discipline

4. **Adding an LLM call without recording it in the trace is a defect.** Tokens, latency, model identity, and computed cost attach to the trace of the answer/run that triggered it.
5. **User-visible data structures come from persisted trace records** — the PWA never reconstructs "how the answer was built" ad hoc; it renders `answer_traces`.
6. **Every pipeline stage's model is config-swappable; every stage's cost is traced.** These two statements are checked together — a stage with a hardcoded model usually also fails to trace cost.

### Decision and vocabulary discipline

7. **Hard-to-reverse, surprising, trade-off decisions get an ADR** in `adr/` (numbered to continue the existing sequence) **before or with** the implementing PR. Never relitigate an accepted ADR in code comments; amend the ADR instead.
8. **Use `CONTEXT.md` vocabulary exactly.** Kitab, Madzhab, Matn, Sharh, Grade, Isnad, Trace, Golden Set, Smart Router — with the definitions and `_Avoid_` lists given there. New domain terms are added to `CONTEXT.md` in the same PR that introduces them.
9. **Tickets and PRs cite their sources.** Implementation PRs reference the issue + relevant ADRs. If you discover the issue contradicts an ADR, stop and surface it — do not pick one silently.
10. **Respect go/no-go gates.** #9 (embedding benchmark) is the gate for the retrieval posture: AR-only vs. ID-fallback fusion is decided by its numbers. Kitab-scale ingestion (#22, #33, #35) must not start before it, because re-embedding is expensive. The dual-index schema is built up front so the choice stays reversible.
11. **Traceability is typed, checked every change.** `Trace` / `TraceEvent` / `CostRecord` are defined in `packages/contracts`; pipeline, PWA, admin, and eval all consume that one shape (ADR-0007 amendment). Refusal/suppression events are recorded with reason and stage, not silently swallowed.
12. **Bound the generator's reasoning; bound the knowledge graph.** KajianQ never synthesizes novel rulings — it surfaces classical reasoning as cited and refuses when evidence is insufficient (ADR-0015). Knowledge layers are bounded, curated, human-reviewed structures — never corpus-wide inferred entity graphs; revisit needs ADR-0016's gate, in an ADR, not inline.

### Data integrity

11. **Never overwrite raw source data.** `text_raw` and original exports are immutable; cleaning/translation always writes new fields. Re-runnable ingestion must be idempotent.
12. **Matn and Sharh are never mixed in one chunk.** Disputed attributions and low-confidence reconciliation matches are quarantined or labeled, never force-merged.

---

## 3. Standard workflow for every ticket

1. **Read before write**: `CONTEXT.md`, the issue with its acceptance criteria, the ADRs it cites, `HANDOFF.md` if present. If the issue is ambiguous, ask — do not guess.
2. **Locate the seam**: which interface does this ticket implement or consume (Provider? RagStore? Router stage?)? Work behind it. If no seam exists and you need one, add the seam first, in its own PR if it changes a public shape.
3. **Ship the slice**: vertical, demoable, within scope guardrails. Keep the template's code style; minimal diffs.
4. **Verify the principles before opening the PR** — run this checklist:
   - Domain boundary: no Islamic-domain identifiers in engine packages (`rg -i "madzhab|hadith|quran|kitab|isnad|sahih|dhaif|syafii" packages/rag-core packages/rag-ingest packages/eval packages/contracts packages/infra/src` should find only tests/docs of the boundary rule itself).
   - No vendor names in engine code or app code outside `packages/infra` Provider adapters and config.
   - No direct DB client imports outside the RagStore adapter and migrations.
   - Any new LLM call records model/tokens/cost to a trace.
   - Any new persisted answer path writes a trace record the UI can render.
   - Vocabulary matches `CONTEXT.md`; new ADRs/Golden Set traps added where the ticket demands.
   - `NOTICES/DATASETS.md` updated when a dataset or corpus resource is touched.
5. **Tick the acceptance-criteria checkboxes** as they verifiably complete (per the working agreements in `HANDOFF.md`).

## 4. Working agreements (from the user — non-negotiable)

- Any agent that completes a task should create a PR using the `pr-creation` skill, then hand it to the user for review. The agent MUST NOT merge the PR unless the user explicitly approves merging it.
- **When an orchestrator spawns a subagent, the orchestrator MUST explicitly instruct the subagent whether it is allowed to create a PR.** The instruction should reference this working agreement and the `pr-creation` skill, e.g. "it's fine to commit, push, and create a PR when ready for me to review." Without that explicit instruction, the subagent must default to waiting for approval before every commit/push/PR.
- PR titles/descriptions in English; create via `gh api --input` with a JSON payload file — never `gh pr edit --field body=....`
- Do not close or modify spec issues (#1, #27). Tick ticket checkboxes via `gh api --input` PATCH.
- Technical docs and code in English; UI copy Indonesian-first (externalized en/id).
- **Fork guardrail amendment (ADR-0009) overrides the template's guardrail.** The `agentic-project-template` AGENTS.md instructs agents: "When adding a dependency, you MUST verify free-tier compatibility. You MUST NEVER add paid services to the critical path." **In this fork, that rule is amended:** paid LLM/embedding APIs **are** accepted in the critical path, because no free tier exists at generator quality (no suitable free tier among the ADR-0009 allowlist for the generator/cheap/reviewer tiers at the required quality). Consequences that still bind every model decision:
  - **Price is weighed in every model decision** — never pick a paid model by default when a free-tier allowlist model meets the quality bar.
  - **Free tiers only where quality allows**; where a paid tier is chosen, that choice is recorded (config + ADR if surprising).
  - **Cost is traced per query** (the typed `CostRecord` in `packages/contracts`) so paid usage stays auditable.
  - **Never route personal data through free tiers.**
  - The template's other dependency guardrails (adapters in `packages/infra`, no `env.*` access direct, no committed secrets) still apply unchanged.

## 5. Model dispatch (for AI-agent implementation)

Ticket labels on `ahaqqu/KajianQ` route the work to the right model:

- No label → default (medium / cheap-tier acceptable).
- `model:high` → implement with a high-reasoning model; do not downgrade. These tickets carry a correctness/trust invariant that fails silently (validators, trap questions, sample audits).
- `model:plus-human` → a human curation/verification gate holds an acceptance criterion (Principle Index, complete-works bibliographies, Golden Set trap design). Code alone never closes the ticket.

**When creating a new ticket later, label it by this heuristic:** if the acceptance criteria include a validator, a trap question, or a sample-audit → `model:high`; if they require owner verification or human review → `model:plus-human`.

## 6. Key references

| Need | Where |
|---|---|
| Domain vocabulary | `CONTEXT.md` |
| Architecture & plan | `kajianq-dars-spec.md` + GitHub issue #1 (v1), #27 (v2) |
| Success factors & phase metrics | `docs/success-factors-and-metrics.md` |
| Decisions | `adr/0005`–`0018` (note: 0010 superseded by 0014; 0006 amended by 0013; 0007 amended for the typed trace contract; 0015/0016 bound generator reasoning and knowledge-graph scope; 0017 anonymous sessions over hosted identity; 0018 AssembledContext carries structured turns + routed query) |
| Current session handoff | `HANDOFF.md` |
| Ticket board | `gh issue list --repo ahaqqu/KajianQ` |
| Dataset attributions | `NOTICES/DATASETS.md` |
