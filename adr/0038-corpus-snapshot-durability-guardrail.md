# ADR-0038: The staged corpus is a durable asset — snapshots bracket every paid ingest

## Decision

1. **Every paid ingest is bracketed by two snapshots** — one verified before the first paid call, one taken after the landed counts are confirmed. Labels are immutable: a snapshot is superseded by a new label, never overwritten.
2. **Snapshots exist at two independent layers,** so no single provider, plan change or deletion can lose the corpus: a provider-side snapshot that restores in place, and a portable dump written through the `ObjectStore` seam with a manifest that makes the claim checkable.
3. **A paid ingest must not start without its pre-snapshot.** The gate refuses the run; verification re-downloads the dump, checks it against its manifest, and compares the manifest's row counts to the live store.
4. **Raw source bytes stay archived in the `ObjectStore` as provenance, so the corpus can be re-derived** — re-derivation costs money, which is why the dump exists as well.

## Why

The staged corpus is bought: embeddings and parent summaries are paid calls, and a full load takes hours, so re-deriving it costs money and time and no accident should be able to lose it. Provider retention alone was not protection — a short restore window and a single manual snapshot cannot express "before" and "after", and those artifacts die with the project or a plan downgrade. A dump written through the storage seam is the mechanism the architecture already anticipated, and a manifest turns "we have a backup" into a checkable claim: the same discipline the eval ledger applies to answers.

Rejected: provider snapshots alone; a raw-source archive alone, which is provenance rather than a restore; a managed continuous-backup tool, deferred as more moving parts than a corpus that changes once per environment; continuous replication or a warm standby, disproportionate for a one-off load.

## Consequences

- Snapshots are superseded by new labels, never deleted in place, so retention is a deliberate act; an archive carrying personal data is flagged and encrypted before it lands (ADR-0043).
- The restore path is deliberately manual: a restore targets a new store, is verified, and only then is the connection repointed; it must never default to a live database.
- This record protects the data; it does not create room for it.
- **Revisit when** ingestion becomes routine (continuous backup is revisited); a dump approaches available memory (the storage seam needs a streaming write); or a production store exists (the same bracketing and a restore drill apply there).
