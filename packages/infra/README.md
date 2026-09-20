# infra — persistence & blob seams

Adapters the engine and apps consume; engine code never imports a database or
vendor client directly (ADR-0008, ADR-0009). What lives here:

- **`RagStore`** — (landed in #4) the single seam for all _engine_ structured
  persistence: corpus chunks with dual embeddings, Traces, chat, anonymous
  sessions, feedback, the generic eval run/result ledger, and model configs.
  `rag-store.ts` defines the interface; `rag-store-postgres.ts` is the
  Postgres + pgvector implementation; `rag-store-postgres-driver.ts` is the
  one place a driver is imported (a `pg` `Pool` adapted to the seam's
  `SqlRunner`); `rag-store-shared.ts` holds the pure, DB-free helpers it
  composes; `rag-store-postgres-query.ts` is the Postgres-specific
  similarity-search SQL builder (pure, unit-tested). Engine/app code consumes
  the interface only.
- **`ObjectStore`** — R2. Holds raw source archives and `text_raw` backups.
- **`Logger` / `ConfigStore`** — template runtime adapters.
- **`RateLimiter`** — moved out of this package into `packages/rate`
  (`@app/rate`), a dedicated reusable package inherited from the template;
  the app resolves its backend from the `RATE_LIMITER` Durable Object
  binding via `resolveRateLimiter`.

> **Domain boundary (AGENTS.md rule 1, ADR-0014 amendment).** This package is
> domain-agnostic. Product-owned tables (`principle_index`, `golden_questions`)
> and the bilingual terminology concept graph (`concept`/`lemma`/
> `concept_relation`/`lemma_evidence`) were originally placed in the engine
> migration (#4) but are domain leakage; they now live in
> `apps/api/migrations` and `packages/kajianq-domain/migrations` respectively.
> `check-boundary.mjs` scans this package's `.sql` for Islamic-domain
> identifiers.

## RagStore

`resolvePostgresStore(DATABASE_URL, opts?)` is the composition-root helper:
it builds a `RagStore` for a connection URL over the module's memoized `pg`
pool, so a caller names the connection and receives the seam. Lower-level
entry points stay available: `createPostgresRagStore(sqlRunner, opts?)` takes
a runner directly, and `createRagStore(provider, sql, opts?)` names the
backend by role (`"postgres"` — the dialect, not the host) instead of
importing the concrete adapter constructor. Pass `opts.logger` for
slow-query/error ops logging (omitted → fully silent). Executable SQL lives
only in `rag-store-postgres*.ts` and the migrations; nothing else may hold a
DB client or query (`check-boundary.mjs` enforces this).

**The seam is Effect-signatured (ADR-0027 decision 7):** every
`RagStore`/`ObjectStore` method returns `Effect<A, StoreError>` and no error
kind travels via `throw` across the seam. `StoreError` is the engine's
closed tagged-union taxonomy (`transport`, `timeout`, `constraint`,
`not_found`, `config` — defined in `@app/rag-core`, re-exported here), each
kind wrapping the original vendor exception in `cause`. Consumers switch on
`kind`, never on adapter or vendor classes. Off-Workers callers bridge with
`Effect.runPromise` at their composition root; the ingestion runner's
bridge (`@app/rag-ingest` pipeline) is the canonical one.

- Anonymous sessions per ADR-0017: `createSession()` mints a 30-day Bearer
  token (stored SHA-256-hashed only) and writes the user + session rows in one
  atomic batched transaction; `resolveUserId(token)` resolves it (rejects
  expired rows); `deleteUserCascade(userId)` removes the user and everything
  they own via `ON DELETE CASCADE` (sessions, chat, feedback, and — per the
  ADR-0007 amendment — the user's `answer_traces`); `cleanupExpiredSessions()`
  reclaims expired session rows (wire to a cron). The auth routes these feed
  are mounted in #10, not here.
- Ingestion is idempotent (AGENTS.md rule 13): `insertDocParent` upserts by
  `source_key` (UNIQUE); `insertDocChild` upserts by `(parent_id, ordinal)`,
  refreshing derived fields but never overwriting immutable `text_raw`.
- The dual embedding columns (`embedding_primary`, `embedding_fallback`) are
  queried via `similaritySearch(track, …)` so the primary-only vs. fusion
  posture decided by the #9 benchmark is a query-layer switch, not a schema
  change (ADR-0013). Track names are role-based; KajianQ maps them onto its
  AR/ID language tracks at the domain-pack layer.
  Embeddings are validated for dimension (1536) and finite components at the
  seam, before they reach Postgres.
- `answer_traces` stores the `@app/contracts` `Trace` shape verbatim and now
  carries `user_id`; the reader is tolerant — the `Trace` contract only ever
  adds optional fields (versioned), so older persisted traces stay readable
  (ADR-0007 amendment).

## Migrations (db-migrate)

Three migration sets share one Postgres database and one `schema_migrations`
ledger; migration _names_ are unique across sets. Apply order is engine →
domain → product (the sets are FK-independent, so any order works).

```sh
DATABASE_URL=postgres://… bun run db:status        # engine: packages/infra
DATABASE_URL=postgres://… bun run db:up
DATABASE_URL=postgres://… bun run db:down

DATABASE_URL=postgres://… bun run db:up:domain      # packages/kajianq-domain
DATABASE_URL=postgres://… bun run db:up:api        # apps/api

# All three sets, in the documented order (engine → domain → product):
DATABASE_URL=postgres://… bun run db:up:all
DATABASE_URL=postgres://… bun run db:down:all       # reverse order: product → domain → engine
DATABASE_URL=postgres://… bun run db:status:all
```

- `db:up:all` / `db:down:all` / `db:status:all` are the bring-up commands:
  they chain the three sets (`db:up && db:up:domain && db:up:api`, reversed for
  `down`). The per-set scripts stay for granular control — partial bring-up as
  each set's ticket lands, and per-set rollback (`db:down:api` rolls back just
  the product set without touching engine/domain).
- `DATABASE_URL` is the server's connection string (vendor-free since
  ADR-0044; `?sslmode=require` against the VPS, loopback plaintext for a local
  scratch cluster).
- Applied migrations are recorded in `schema_migrations(name)`; `up` is a
  no-op when nothing is pending.
- The CLI self-describes via this package's `bin` field
  (`db-migrate` → `scripts/db-migrate.mjs`). Bun does not link workspace
  member bins into `node_modules/.bin`, so inside this monorepo the root
  `db:*` scripts remain the canonical invocation; the `bin` entry keeps the
  manifest honest about its operational commands.
- Engine `migrations/0001_init.sql` is the domain-agnostic v1 schema (corpus,
  traces, chat, anonymous sessions, feedback, eval ledger, model configs).
- Domain `packages/kajianq-domain/migrations/0001_concept_graph.sql` follows
  ADR-0014's DDL verbatim, with one noted adaptation: `lemma_evidence.ayah_pair_id`
  is a plain `uuid` until #6 lands the aligned-ayah table, at which point it
  can be promoted to a real FK.
- Product `apps/api/migrations/0001_product.sql` creates `principle_index` and
  `golden_questions`.
- Corpus sizing / storage cost of the dual-vector schema is decided in
  [ADR-0020](../../adr/0020-neon-dual-vector-sizing.md).

### Production bring-up

When the production Postgres database is provisioned (the VPS, ADR-0044), apply the full v1 schema with
`bun run db:up:all` (one command, engine → domain → product). Notes:

- The engine `0001_init.sql` was **edited in place** during the #4 review
  fix-forward (PR #62): the earlier merged `0001` had created the
  product/domain tables too, and the new `0001` is domain-agnostic only.
  Production must run the **current** `0001` (not a stale copy) plus the
  domain and product sets — `db:up:all` does exactly this.
- **Staging** was torn down and re-applied as the testbed for this shape (PR
  #62); production has no data yet, so the first `db:up:all` is greenfield with
  nothing to roll back.
- Roll back a single set with `db:down:{api,domain}` (per-set `down`) or the
  whole shape in reverse with `db:down:all`. The engine `down.sql` drops only
  engine tables; the domain and product sets have their own down-migrations.

## One-off probes (results recorded in the #4 PR)

```sh
bun run db:probe:pg-search   # pg_search/BM25 availability on the plan (AC)
bun packages/infra/scripts/r2-verify.mjs   # R2 read/write from the CLI env (AC)
```

## Contract tests

`src/rag-store-postgres.test.ts` is an integration suite against a real
Postgres database. It is **skipped unless `DATABASE_URL` is set**, so the
default `bun run test` job stays green without a database. In CI these run in
the `postgres:contract` job — which engages on every PR touching
`packages/infra` — against a `pgvector/pgvector:pg18` service container (the
same image the restore drill uses), with `--no-file-parallelism` (the tests
share one fixture namespace keyed off a per-run prefix, so parallel files
would race). The suite is Effect-shaped (ADR-0027 decision 7): each test
composes its seam calls into one `Effect.gen` program with a single
`Effect.runPromise` at the test's edge. The pure query builder
(`rag-store-postgres-query.ts`), the driver adapter
(`rag-store-postgres-driver.ts`), and the shared helpers
(`rag-store-shared.ts`) are unit-tested and run in every environment.
