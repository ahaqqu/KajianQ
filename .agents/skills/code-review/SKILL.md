---
name: code-review
description: Use when reviewing a pull request after it is created. The single review entry point — sets the review depth (normal for docs/skill-only changes, thermos mandatory for anything touching code) and verifies philosophy and guardrail compliance.
source: project
synced: 2026-08-29
---

# Code Review

Use this skill when reviewing a pull request after it has been created. It is the single entry point for all review: the thermo passes are reached through this skill — always via `.agents/skills/thermos-with-comments/SKILL.md`, which posts the itemized findings on the PR.

## Review depth (determined by the change, not negotiated)

- **Normal** — this skill's philosophy and guardrail review only. Allowed only when the PR touches **no code**: docs, skills, agent-instruction files, ADRs, specs, and similar non-runtime surfaces.
- **Thermos (mandatory for code)** — if the diff touches any runtime code (`apps/`, `packages/`, `scripts/`, migrations, CI workflows), run `.agents/skills/thermos-with-comments/SKILL.md`: dispatch both thermo-nuclear sub-reviewers (security/correctness + maintainability) and post the itemized findings as PR comments. This is not optional and not a recommendation — a PR that changes code is always reviewed at thermos depth.

There is no third depth. If a PR mixes code and docs, thermos applies to the whole PR.

Under the manager-orchestrated loop, the `reviewer` role applies this skill and posts findings as itemized PR comments via `.agents/skills/thermos-with-comments/SKILL.md` instead of synthesizing in chat — same passes, same depth rule, comment-based deliverable.

## Inputs

- The pull request diff.
- `docs/ARCHITECTURE.md` — verify the changes align with the principles (§1–§14, including the KajianQ amendments, e.g. §4 server-authoritative state).
- `AGENTS.md` — universal guardrails and Definition of Done.
- `.agents/skills/dars-pluggability/SKILL.md` and `.agents/skills/kajianq-traceability/SKILL.md` — the domain checklists and anti-pattern lists.

## Philosophy alignment

Check the PR against the principles in `docs/ARCHITECTURE.md`. The KajianQ-specific ones that fail silently and deserve explicit verification:

- **Pluggable (§1)** — does the change work behind the seams (pipeline stages, `Provider`, `RagStore`, `ObjectStore`)? Is anything hardcoded that belongs in `model_configs` config?
- **Traceable (§2)** — every new LLM call records model identity, tokens, latency, and cost to the trace; the UI renders persisted trace records, not ad hoc reconstructions.
- **Cost (§3)** — price weighed in every model decision. Note the ADR-0009 amendment: paid LLM/embedding APIs are accepted in the critical path — do not flag them as violations, but verify the choice is recorded (config + ADR if surprising) and cost is traced per query.
- **State (§4)** — server-authoritative; no client-side source of truth.
- **Domain boundary (§14 + `dars-pluggability`)** — no Islamic-domain logic, vendor names, or direct SQL in engine packages.

For the inherited principles (§5–§13), enumerate them from `docs/ARCHITECTURE.md` at review time and check the PR did not regress them — do not trust any summary in this file.

## Guardrail compliance

For each changed file, verify against `AGENTS.md` universal guardrails and the `guided-implementation` domain checklists:

- External service access through adapters in `packages/infra`; no direct `env.*` access in business logic.
- No vendor or model names outside `packages/infra` Provider adapters and `model_configs` config.
- No direct DB client imports outside the `RagStore` adapter and migrations; schema changes follow the RagStore migration conventions.
- New LLM calls traced (model identity, tokens, latency, cost); pipeline wiring through the `runPipeline` runner (`RunContext`), never hand-assembled traces (ADR-0021).
- `text_raw` immutable; ingestion idempotent; Matn and Sharh never mixed in one chunk; disputed attributions quarantined or labeled.
- User-facing strings externalized for `en` and `id`; logging via the Logger adapter, no `console.log`; secrets via `wrangler secret`, nothing committed.
- Files 300 lines or fewer with 5 or fewer direct dependencies; trace/response shapes shared via `packages/contracts` (`@app/contracts`).
- Run the Quick review scans from `dars-pluggability` (domain leakage, vendor names, direct SQL) — each hit is a refactor or a recorded ADR exception.

## Output

Report:

- Philosophy violations: which principle (cite the `docs/ARCHITECTURE.md` section), which file, and why.
- Guardrail violations: which rule, which file and line.
- Thermo findings (when code was touched): the itemized report posted by thermos-with-comments (A/B/C IDs), merged and prioritized.
- Approval or rejection with justification.

Block the PR on any MUST or MUST NOT violation. Flag SHOULD violations for author response.
