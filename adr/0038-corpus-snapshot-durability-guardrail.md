# ADR-0038: The staged corpus is a durable asset — snapshots bracket every paid ingest

## Status

Proposed (2026-09-12). Applies to every corpus-bearing store (staging today,
production when it exists) and to every money-spending ingest. Complements
ADR-0037: that ADR bounds what one run may spend, this one guarantees the result
of a run can be recovered.

## Context

- The staged corpus is **bought**: embeddings and parent summaries are paid vendor
  calls, and a full hadith load takes roughly two hours. Re-deriving it costs
  money and time, so it is not an artifact anyone should be able to lose by
  accident.
- Nothing protected it. Measured on 2026-09-12: both R2 buckets held **0 objects**
  (the Quran ingest had run through CI without R2 credentials and recorded
  `archiveStored: false`), the Neon project held **0 manual snapshots**, and the
  free plan's restore window is **6 hours**, capped at 1 GB of change history.
- The same plan caps storage at **0.5 GB per project**, while the full hadith
  corpus projects to roughly **1.35 GB** — so the store was simultaneously
  under-protected and about to outgrow its plan. Neither fact was visible until
  measured; both were found while preparing an ingest that would have spent money.
- On the free plan there is exactly **one** manual snapshot, so provider snapshots
  alone cannot express "before" and "after".
- `docs/ARCHITECTURE.md` §11 stated that the ObjectStore "remains the place a real
  backup/export lands if adopted". It had not been adopted.

## Decision

1. **Every paid ingest is bracketed by two snapshots** — a verified
   `pre-ingest-<UTC>` taken before the first paid call, and a `post-ingest-<UTC>`
   taken after the landed counts are confirmed. Labels are immutable: `create`
   refuses a label that already exists, so a snapshot can only be superseded by a
   new one, never overwritten.
2. **Snapshots exist at two independent layers**, so no single provider, plan
   change, or deletion can lose the corpus:
   - **Provider layer** — a Neon branch/manual snapshot: fast, copy-on-write,
     restorable in place.
   - **Portable layer** — `pg_dump --format=custom` plus a **manifest** (sha256,
     byte size, per-table row counts, server version, applied migrations, git sha)
     written through the ObjectStore seam to `snapshots/<label>/`. Independent of
     the provider; survives project deletion, a plan downgrade, or a move to a v2
     embedding space.
3. **A paid ingest must not start without its pre-snapshot.**
   `bun run db:snapshot require <label>` is the gate; `verify` re-downloads the
   dump, checks its sha256 against the manifest, and compares manifest row counts
   to the live database.
4. **Raw source bytes stay archived** in the ObjectStore as provenance, so the
   corpus can also be re-derived from scratch — re-derivation costs money, which
   is precisely why the dump exists as well.

## Rationale

- An asset that costs money to create must not depend on one provider's retention
  window. Six hours of history does not cover finding a defect the next morning,
  and a single manual snapshot cannot express two checkpoints.
- A dump written through the ObjectStore seam is the mechanism
  `docs/ARCHITECTURE.md` §11 already anticipated; adopting it closes a documented
  open question instead of introducing a new service.
- A manifest carrying sha256 and row counts turns "we have a backup" into a
  checkable claim. That is what makes the guardrail reviewable rather than
  aspirational — and it is the same discipline the eval ledger applies to answers.

## Alternatives considered

- **Provider snapshots only (Neon branches / manual snapshots).** Rejected: one
  manual snapshot and six hours of history on the free plan, and the artifacts die
  with the project or a plan downgrade.
- **Raw-source archive only.** Rejected as the sole layer: it is provenance, not a
  restore — recovering from it means re-embedding the corpus and paying again.
- **A managed backup tool (WAL-G / pgBackRest to R2).** Deferred: more moving
  parts than a corpus that currently changes once per environment. Revisit if
  ingestion becomes continuous.
- **Continuous logical replication or a warm standby.** Rejected as
  disproportionate for a one-off load.

## Consequences

- R2 grows by one dump per snapshot (~0.2 GB today, plausibly 0.5–1.0 GB at full
  corpus) against a 10 GB free tier — cheap, but not free forever. Snapshots are
  superseded by new labels, never deleted in place, so retention is a deliberate
  act.
- The script reads a dump into memory to write it through the seam, because
  `ObjectStore.put` takes bytes rather than a stream; at full corpus that is a
  ~1 GB allocation. If it becomes a problem the seam needs a streaming write —
  a deliberate change, not an accident.
- A snapshot is only as good as its restore path, and that path is deliberately
  manual: `restore-plan` prints the exact `pg_restore` invocation, which uses
  `--clean` and must never default to a live database. Restore into a new branch
  or project, verify, then repoint `DATABASE_URL`.
- This ADR protects the data; it does **not** create room for it. The 0.5 GB
  free-plan cap still blocks the full corpus and is tracked separately.

## Implementation map

- `packages/infra/scripts/db-snapshot.mjs` — the CLI (`create`, `verify`,
  `require`, `list`, `download`, `restore-plan`).
- `packages/infra/scripts/snapshot-store.mjs` — ObjectStore/R2 plumbing.
- `package.json` — `bun run db:snapshot`.
- `docs/ARCHITECTURE.md` §11, `AGENTS.md` (guardrail + Definition of Done),
  `SPECS.md` §8, `docs/GLOSSARY.md`.

## Revisit triggers

- Ingestion becomes routine → revisit continuous backup (WAL-G / pgBackRest).
- A dump approaches available memory → add a streaming `put` to the ObjectStore seam.
- A production store exists → apply the same bracketing to production restores and
  run a restore drill.
