# ADR-0019: Boundary gate scans engine migration SQL, not just TypeScript

## Status

Accepted (2026-08-25, PR #54 follow-up).

## Context

AGENTS.md rule 1 is non-negotiable and PR-blocking: engine packages (`rag-core`, `rag-ingest`, `eval`, `contracts`, `infra`) contain ZERO Islamic-domain logic. The enforcement tool, `scripts/check-boundary.mjs`, scans engine-package source for domain identifiers, vendor names, and direct DB clients.

PR #54 (#4: Neon+pgvector behind the RagStore adapter) placed product-domain tables in the engine migration `packages/infra/migrations/0001_init.sql`: `principle_index`, `golden_questions`, and the ADR-0014 terminology concept graph (`concept`/`lemma`/`concept_relation`/`lemma_evidence` with `ayah_pair_id` / `evidence_ayah_ids`). The gate reported **0 violations** — a false negative — because it only scanned `.(ts|tsx|mts|cts)` files and only listed `packages/infra/src`, not `packages/infra/migrations`. So executable DDL encoding domain vocabulary sat entirely outside the gate. The thermo review of PR #54 surfaced this as a High-severity guardrail gap.

Separately, the DB-client rule's regex missed several real coupling shapes — `neon(`, `new Pool`, dynamic `import("pg")` — and exempted the whole `packages/infra/scripts/` directory (its own comment said "nothing else may opt out"), which would let any future script in that dir bypass all three rules.

## Decision

1. **Scan `.sql` under `packages/infra/migrations`.** `engineFiles()` now lists tracked `.sql` files alongside `.ts*`, and `packages/infra/migrations` is added to the scanned package list. The domain-identifier rule applies to both TS and SQL; the vendor and DB-client rules apply to TS only (a SQL DDL file legitimately contains SQL, not a driver import or a vendor config value).
2. **Add `ayah` to the domain-identifier pattern** so a future engine migration cannot encode Quran-verse references (the concept graph with `ayah_pair_id` now lives in the domain pack per the ADR-0014 amendment; `ayah` in an engine `.sql` would be a real violation).
3. **Harden the DB-client pattern** to also catch `neon(`, `new Pool`, and dynamic `import("pg")`, not just static `from "pg"` / `@neondatabase` / `postgres(` / `createPool` / `.prepare(`.
4. **Narrow the DB-client exemption to an explicit allowlist** — the adapter's own integration test (`rag-store-neon.test.ts`) and the two infra scripts that own migrations/probes (`db-migrate.mjs`, `pg-search-probe.mjs`) — instead of the whole `packages/infra/scripts/` directory.
5. **Enforce `bun run boundary` in the CI gate job** so the boundary is PR-blocking in CI, not just a local checklist item.

## Consequences

- An engine migration that introduces `principle_index`, `golden_questions`, `concept`/`lemma`/`lemma_evidence`, `ayah`, or any CONTEXT.md Islamic term now fails CI with a file:line pointer. Product-owned and domain-owned tables must live in `apps/api/migrations` and `packages/kajianq-domain/migrations` respectively (see the ADR-0014 amendment).
- The Neon adapter's doc comments are kept driver-name-free where it is merely illustrative (`neon(url)` → "the driver query handle"), because the adapter itself takes an injected `SqlRunner` and does not import the driver — the only driver imports are in the exempted test and scripts.
- The gate does **not** attempt to regex generic words like `principle`, `golden`, `lemma`, or `concept` (they are legitimate CS/NLP terms and would cause false positives in engine code); ownership of those product concepts is enforced by relocation + review, and by the clearly-Islamic `ayah` term at the gate level.

## Relationship to existing ADRs

- **ADR-0014:** amended (same date) to relocate the concept graph to the domain pack; this ADR's `.sql` scanning is what would have caught the original placement.
- **ADR-0008:** the RagStore seam stays the single persistence interface; this ADR only tightens the boundary that protects it.
- **AGENTS.md §2 rule 1/3:** this ADR operationalizes rule 1 for `.sql` and tightens rule 3's detection.