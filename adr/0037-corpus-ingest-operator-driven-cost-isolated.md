# ADR-0037: Corpus ingest is operator-driven and cost-isolated from the evidence gate

## Decision

1. **An ingestion pass is bounded to an explicit collection range, and resumption is by measured store state:** the operator reads the landed counts and ingests only the collections still missing. A pass whose collection already landed is never re-run.
2. **The deploy-and-verify workflow carries no corpus-ingest job.** Corpus load is an operator-driven local action, so a money-spending job can never gate an evidence-producing one.

## Why

Upsert-only idempotency dedupes rows but not spend: a re-run re-pays for every embedding and summary it re-reads, and there is no skip-if-present check and no spend cap on the ingest path. A per-row existence check inside the embedding loop would make the report's cost semantics depend on store state; bounding the blast radius to one collection per pass reaches the same cost containment with no engine change and no new failure mode. Coupling the two jobs made a corpus failure indistinguishable from an evidence failure, so a failed ingest cost money and produced no evidence. Keeping ingestion in CI also required object-store credentials as CI secrets inside a deploy-and-verify workflow, where they do not belong.

Rejected: skip-if-present inside the runner for now — a store read in the hot embedding loop, where a committed only-missing guard is the cheaper seam if ingestion ever becomes routine; keeping the opt-in job with the evidence job running regardless, which leaves a long money-spending job inside the evidence workflow and lets a partially-ingested corpus degrade the smoke into a false green; a separate ingest workflow file, which cannot be dispatched from a branch.

## Consequences

- Re-ingesting a landed collection to repair anything other than that collection's own rows is forbidden. Nothing enforces it mechanically: it is operator discipline, which is exactly why it is written down.
- There is no archive-only repair path — raw sources are archived by the ingest itself — so object-store credentials are verified before the first paid pass.
- Per-pass cost is bounded by the collection's size; the enforced bound is volume, checked after every pass against the counts the source declares.
- **Revisit when** corpus loading becomes routine (a committed only-missing guard narrows the operator's range without replacing the bounded pass); embedding spend becomes real (a spend cap joins the volume bound); or a disposable, restorable store makes a return to CI safe.
