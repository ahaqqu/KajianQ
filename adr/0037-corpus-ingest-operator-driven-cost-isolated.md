# ADR-0037: Corpus ingest is operator-driven and cost-isolated from the evidence gate

## Status

Accepted (2026-09-12). Governs the `Staging` workflow and both ingest CLIs
(`ingest:quran`, `ingest:hadith`). Replaces the `ingest_corpus` dispatch
mechanism described in `SPECS.md` §2; the ADR-0009 cost posture and ADR-0034
budget semantics are unchanged.

## Context

- The ingestion runner (`packages/rag-ingest/src/pipeline.ts`) parses a run's
  parents, summarizes them (LLM, costed), then embeds **both tracks for every
  child of the run**, and only afterwards upserts the children. Idempotency is
  by upsert key (parents by `sourceKey`, children by `(parentId, ordinal)`,
  pairs by `pairKey`), so re-running duplicates no rows — but it **re-pays**
  for every embedding and summary it re-reads. There is no skip-if-present
  check and **no spend cap on the ingest path at all**.
- `packages/infra/src/providers/models.json` prices both embedding models at
  `{in: 0, out: 0}`, so `IngestionReport.costMicroUsd` cannot surface embedding
  spend even when the vendor bills for it.
- The `Staging` workflow previously carried an opt-in `ingest` job, and its
  `staging` job declared `needs: [ingest]` with
  `if: always() && needs.ingest.result != 'failure' && != 'cancelled'`.
- On 2026-09-12 four dispatches failed in the ingest job (runs `34670922506`,
  `34671080796`, `34672651695`, `34673591725`). Each spent vendor money, and
  each skipped the smoke job entirely: money out, **no evidence**. The last
  burned roughly 40 minutes of embeddings before failing.

## Decision

1. An **Ingestion Pass** is bounded to an explicit collection range
   (`--offset N --limit 1`). Resumption is by **measured store state**: the
   operator reads the landed counts and ingests only the collections that are
   still missing. A pass whose collection already landed is never re-run.
2. The `Staging` workflow carries **no** corpus-ingest job — the job and its
   `ingest_corpus` / `ingest_scope` dispatch inputs are removed. Corpus load is
   an operator-driven local action. A money-spending job must never gate an
   evidence-producing job.

## Rationale

- Upsert-only idempotency is the right _persistence_ invariant and the wrong
  _cost_ invariant. Per-row existence checks would put a store read inside the
  embedding loop and make the report's cost semantics depend on store state;
  bounding the blast radius to one collection per pass reaches the same cost
  containment with no engine change and no new failure mode.
- Coupling the jobs made a corpus failure indistinguishable from an evidence
  failure: the run went red on the ingest, and the smoke — the thing the PR
  actually needed — never ran. Decoupling means a failed ingest costs money,
  never evidence.
- Keeping ingestion in CI also required R2 credentials as GitHub secrets and a
  300-minute timeout. Neither belongs in a deploy-and-verify workflow.

## Alternatives considered

- **Skip-if-present inside the runner.** Rejected for now: it moves a store read
  into the hot embedding loop and makes cost semantics store-dependent. A
  committed `--only-missing` guard is the cheaper seam if ingestion ever becomes
  routine.
- **Keep the opt-in job but let `staging` run anyway** (`if: always()`).
  Rejected: it leaves a 300-minute, money-spending job inside the evidence
  workflow, and a partially-ingested corpus would silently degrade the smoke's
  retrieval recall rather than fail it — the worst kind of red-to-green.
- **A dedicated ingest workflow file.** Not viable: `workflow_dispatch` only
  resolves workflow files that exist on the default branch, so a separate file
  could not be dispatched from a PR branch.

## Consequences

- Re-ingesting a landed collection to "repair" anything other than that
  collection's own rows is forbidden. Nothing enforces this mechanically: it is
  operator discipline, which is precisely why it is written down.
- There is no archive-only repair path. `archiveRawSources` has exactly one
  caller, inside the ingest CLIs, so re-archiving raw source bytes after the
  fact requires a full ingest — re-embedding everything. R2 credentials are
  therefore verified **before** the first paid pass.
- Per-pass cost is bounded by the collection's size. There is still no hard
  spend cap on the ingest path; the enforced bound is **volume**, checked after
  every pass against the counts the source declares.
- The ledger continues to under-report embedding spend while `models.json`
  prices embeddings at 0 (tracked as a follow-up).

## Implementation map

- `.github/workflows/staging.yml` — ingest job and its two dispatch inputs
  removed; the `staging` job has no `needs`/`if` coupling.
- `.github/workflows/neon-schema-reapply.yml` — its data-loss warning now points
  at the local, operator-driven ingest.
- `SPECS.md` §2 (staging corpus) and §8 (record of decisions).
- `packages/kajianq-domain/scripts/collection-range.mjs` — the `--offset` /
  `--limit` slice that makes a pass bounded and resumable.

## Revisit triggers

- Corpus loading becomes routine (new collections per release) → add a committed
  `--only-missing` guard and revisit decision 1.
- Embedding prices stop being booked at 0 → add a real spend cap to the ingest
  path.
- Staging gains a disposable, restorable database → ingestion could return to CI
  without the money/evidence coupling risk.
