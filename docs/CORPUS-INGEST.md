# Corpus ingest — the operator runbook

How to load the corpus (Quran, hadith collections) onto a store — the
self-hosted VPS Postgres post-cutover (ADR-0044) or any fresh
`DATABASE_URL`-named store of your own. Corpus loading is **operator-driven
from a local machine** and **cost-isolated from CI** (ADR-0037): the `Staging`
workflow carries no ingest job, so this document is the one place the whole
sequence — preconditions, the snapshot gate, the passes, verification — is
written down. `docs/VPS-OPERATIONS.md` is the manual for the box itself
(deploy, Postgres posture, backups); `docs/VPS-SETUP.md` stands a box up.

| Question                                         | Answered by                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| Why local, why one collection per pass           | [ADR-0037](../adr/0037-corpus-ingest-operator-driven-cost-isolated.md) |
| Why snapshots bracket every pass                 | [ADR-0038](../adr/0038-corpus-snapshot-durability-guardrail.md)        |
| Which corpus is loaded where and why             | [ADR-0039](../adr/0039-staging-minimal-corpus-mvp-scope.md), SPECS §2  |
| What was actually run on the project's own store | this file's **A full-corpus run** (appended per run)                   |

## 0. Preconditions (check before the first paid pass)

The ingest CLI reads a `.env` at the repository root (`.env.example` documents
every key; the serving process never reads this file). Three groups matter:

| Variable                                                      | Why                                                                                                                                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                | the store the pass writes to. Against the VPS: **an ssh tunnel** (§2.8 of the operations manual) with the URL at the **tunnel port** (`127.0.0.1:15433` locally, matching the CI convention) |
| `GEMINI_PAID_API_KEY`                                         | the embedder role's key — embeddings ride the **paid** `gemini-paid` row (`models.json`); the free tier's ~1,000 items/day wall is infeasible for corpus runs (ADR-0036)                     |
| `DEEPSEEK_API_KEY`                                            | the `cheap` role's key — parent section summaries bill here                                                                                                                                  |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | the raw-source archive and the snapshot dumps (ADR-0038). Absent ⇒ the pass reports `archiveStored: false` and the ADR-0038 provenance precondition fails                                    |

Verify each before spending:

```bash
# the provider roles resolve (embedder must say gemini-embedding-001, missingKeys [])
bun -e 'import * as app from "./packages/infra/src/index.ts";
const c = app.loadProviderConfig();
console.log("embedder:", app.resolveRole(c, "embedder", { env: process.env }).provider.modelId,
            app.resolveRole(c, "embedder", { env: process.env }).missingKeys)'  # from repo root

# R2 reachable, snapshots listable
bun run db:snapshot list

# migrations current on the target
DATABASE_URL="$DATABASE_URL" bun run db:status:all
```

Tunnel (the DB is loopback-only; §2.8 of the ops manual is the source):

```bash
ssh -N -L 15433:127.0.0.1:5432 <user>@<host>        # keep open for every pass
export DATABASE_URL="postgres://kajianq:<pw>@127.0.0.1:15433/kajianq"
```

The connection role is `kajianq` (not the superuser) — it has the corpus
tables' read/write through the adapter, which is all a pass needs. The
password lives in `/etc/kajianq/db-password` on the box (root 0600) and in the
owner's password manager; never in shell history, never in argv.

## 1. The snapshot gate (ADR-0038 — no paid pass without it)

Every money-spending pass is bracketed by two verified snapshots. The staged
corpus is a paid asset; `bun run db:snapshot require <label>` is the gate, and
the pre-snapshot is verified before the first paid call.

```bash
# BEFORE the pass — the pre-snapshot
KAJIANQ_SNAPSHOT_ENCRYPTED_AT_REST=true bun run db:snapshot create pre-ingest-<utc-lowercase-t-z>
bun run db:snapshot verify pre-ingest-<…>          # must be clean: sha + corpus counts match live
bun run db:snapshot require pre-ingest-<…>         # the gate; fails loudly when missing/unverified
```

- Labels are lowercase letters/digits/dashes (`pre-ingest-20260926t0900z` —
  **lowercase `t`/`z`**; the CLI's regex rejects uppercase).
- Labels are immutable: a re-take is a new label, never an overwrite.
- The archive carries personal data (a whole-database `pg_dump`), so `create`
  demands the posture flag above — post-cutover the target is the VPS box
  (encrypted-at-rest posture, ADR-0043 decision 5).
- `verify` partitions tables: `doc_parents`/`doc_children`/`aligned_pairs`/
  `schema_migrations` must match the live database exactly; ledger/personal
  tables legitimately moved on and are only reported. A red verify is never
  "fixed" by re-snapshotting.

## 1b. What a pass costs, and the abort rule

Price is weighed per model by config (`models.json`); embeddings bill on the
paid row (~$0.20/MTok input) and parent summaries on DeepSeek. **Hard rule:
stop and report if a pass's reported `costMicroUsd` passes $5** (ADR-0037 —
the report is persisted to `eval_runs` and written by `HADITH_REPORT_DIR`).

The ingest runner embeds _and writes_ a whole run's children together: a pass
is all-or-nothing in cost (not in persistence — upserts commit per batch).
That is why a pass is bounded to **one collection**
(`--offset N --limit 1`), and why re-running a landed collection re-pays for
it: idempotency dedupes rows, never spend.

## 2. The pass sequence

For each collection (offsets in `HADITH_COLLECTIONS` order: bukhari 0,
muslim 1, abudawud 2, tirmidhi 3, nasai 4, ibnmajah 5, malik 6):

```bash
# 1. The free integrity check — no LLM/embedding spend, store untouched.
#    This is also how a collection's *declared* count is recorded.
bun run ingest:hadith -- --check --offset <N> --limit 1

# 2. The paid pass, snapshot-bracketed (§1).
bun run ingest:hadith -- --offset <N> --limit 1

# 3. Verify the landed count equals the declared count.
DATABASE_URL="$DATABASE_URL" psql "$DATABASE_URL" -t -c \
  "SELECT metadata->>'collection', count(*) FROM doc_children
   WHERE metadata->>'collection' = '<name>' GROUP BY 1;"
```

`--only-missing` replaces the manual offset arithmetic when the set of
missing collections is unknown or more than one pass is planned:

```bash
# Reads landed counts through the store seam FIRST (a store read before the
# spend, never inside the embedding loop — ADR-0037's recorded revisit
# trigger), drops already-landed collections, and refuses a no-op paid pass.
bun run ingest:hadith -- --only-missing
# Combine with a range: narrow --only-missing to that range's slice.
bun run ingest:hadith -- --only-missing --offset 0 --limit 3
```

Guard semantics (ADR-0037, folded in from #141): a pass whose collections all
carry children already exits with an error naming the counts — a naive
`for i in 0..6` loop cannot silently re-pay for thousands of rows. Passes
whose `--offset` slice is empty after narrowing are skipped, not spent.

### 2b. The incremental property (verified, not assumed)

Re-landing a collection is forbidden outside that collection's own repair
(ADR-0037's consequence). After every pass, the already-landed collections
must be demonstrably untouched:

```sql
-- counts unchanged
SELECT metadata->>'collection', count(*) FROM doc_children GROUP BY 1;
-- rows not re-stamped: max(created_at) per already-landed collection stays put
SELECT metadata->>'collection', max(created_at) FROM doc_children GROUP BY 1;
```

The `--only-missing` guard makes a mistaken re-pay _impossible from the CLI_;
the two queries make it _visible_ if it happened by any other route.

## 3. After the passes

1. **Post-ingest snapshot per pass** (or one after the final pass, per run
   label; ADR-0038): `create` + `verify`, cite both labels.
2. **Storage measured**: `df -h /srv` on the box plus
   `SELECT pg_size_pretty(pg_database_size(current_database()));` through the
   tunnel — the sizing numbers future decisions read.
3. **Golden Set smoke** (`bun run eval:smoke` against the serving URL +
   tunnelled `DATABASE_URL`, or the `Staging` workflow dispatch): the
   standing post-cutover health signal — **a red smoke is an incident, not a
   flake**.
4. **Retrieval recall re-baseline**: a recall number measured on the smaller
   store does not describe the widened one; record the new mean per run
   (the `Staging` workflow prints it; the eval ledger persists it).
5. **Docs true in the same PR** (AGENTS.md living-documents rule): SPECS §2/
   §3.2 corpus numbers, ADR-0039's scope statement, `NOTICES/DATASETS.md`
   (confirm, don't assume), and the run record below.

## 4. A full-corpus run — append-only record

| Run                              | Collections                   | Pre/post snapshot labels                                       | Landed counts             | Cost                       | Notes                             |
| -------------------------------- | ----------------------------- | -------------------------------------------------------------- | ------------------------- | -------------------------- | --------------------------------- |
| 2026-09-12 (Neon, staging)       | quran; malik (ADR-0039 scope) | `pre-ingest-20260912t121320z` / `post-ingest-20260912t125416z` | quran 6,236 + malik 1,829 | 126 micro-USD (malik pass) | carried to the VPS by the cutover |
| (this entry is appended per run) |                               |                                                                |                           |                            |                                   |

## Related

- [`docs/VPS-OPERATIONS.md`](./VPS-OPERATIONS.md) §2.4/§2.8 — snapshot CLI + the ssh tunnel
- [`adr/0037-…`](../adr/0037-corpus-ingest-operator-driven-cost-isolated.md) — operator-driven, cost-isolated
- [`adr/0038-…`](../adr/0038-corpus-snapshot-durability-guardrail.md) — the snapshot discipline
- [`adr/0039-…`](../adr/0039-staging-minimal-corpus-mvp-scope.md) — the minimal-corpus scope (production retires it)
- [`adr/0036-…`](../adr/0036-embedding-benchmark-gate-retrieval-posture.md) — the embedding posture
- [`NOTICES/DATASETS.md`](../NOTICES/DATASETS.md) — the corpus sources
