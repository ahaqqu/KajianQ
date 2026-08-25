# infra — persistence & blob seams

Adapters the engine and apps consume; engine code never imports a database or
vendor client directly (ADR-0008, ADR-0009). What lives here:

- **`RagStore`** — (landed in #4) the single seam for all *engine* structured
  persistence: corpus chunks with dual embeddings, Traces, chat, anonymous
  sessions, feedback, the generic eval run/result ledger, and model configs.
  `rag-store.ts` defines the interface; `rag-store-neon.ts` is the Neon
  Postgres + pgvector implementation; `rag-store-shared.ts` holds the pure,
  DB-free helpers it composes; `rag-store-neon-query.ts` is the Neon-specific
  similarity-search SQL builder (pure, unit-tested). Engine/app code consumes
  the interface only.
- **`ObjectStore`** — R2. Holds raw source archives and `text_raw` backups.
- **`Logger` / `ConfigStore` / `RateLimiter`** — template runtime adapters.

> **Domain boundary (AGENTS.md rule 1, ADR-0014 amendment).** This package is
> domain-agnostic. Product-owned tables (`principle_index`, `golden_questions`)
> and the bilingual terminology concept graph (`concept`/`lemma`/
> `concept_relation`/`lemma_evidence`) were originally placed in the engine
> migration (#4) but are domain leakage; they now live in
> `apps/api/migrations` and `packages/kajianq-domain/migrations` respectively.
> `check-boundary.mjs` scans this package's `.sql` for Islamic-domain
> identifiers.

## RagStore

`createNeonRagStore(sql)` takes the query object returned by
`neon(NEON_DATABASE_URL)` and returns a `RagStore`. Prefer
`createRagStore(provider, sql, opts?)` when wiring by config: it names the
backend by role (`"neon"` today) instead of importing the concrete adapter
constructor. Pass `opts.logger` for slow-query/error ops logging (omitted →
fully silent). Executable SQL lives only in
`rag-store-neon.ts`, `rag-store-neon-query.ts`, and the migrations; nothing
else may hold a DB client or query (`check-boundary.mjs` enforces this).

- Anonymous sessions per ADR-0017: `createSession()` mints a 30-day Bearer
  token (stored SHA-256-hashed only) and writes the user + session rows in one
  atomic Neon HTTP transaction; `resolveUserId(token)` resolves it (rejects
  expired rows); `deleteUserCascade(userId)` removes the user and everything
  they own via `ON DELETE CASCADE` (sessions, chat, feedback, and — per the
  ADR-0007 amendment — the user's `answer_traces`); `cleanupExpiredSessions()`
  reclaims expired session rows (wire to a cron). The auth routes these feed
  are mounted in #10, not here.
- Ingestion is idempotent (AGENTS.md rule 11): `insertDocParent` upserts by
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

Three migration sets share one Neon database and one `schema_migrations`
ledger; migration *names* are unique across sets. Apply order is engine →
domain → product (the sets are FK-independent, so any order works).

```sh
NEON_DATABASE_URL=postgres://… bun run db:status        # engine: packages/infra
NEON_DATABASE_URL=postgres://… bun run db:up
NEON_DATABASE_URL=postgres://… bun run db:down

NEON_DATABASE_URL=postgres://… bun run db:up:domain      # packages/kajianq-domain
NEON_DATABASE_URL=postgres://… bun run db:up:api        # apps/api

# All three sets, in the documented order (engine → domain → product):
NEON_DATABASE_URL=postgres://… bun run db:up:all
NEON_DATABASE_URL=postgres://… bun run db:down:all       # reverse order: product → domain → engine
NEON_DATABASE_URL=postgres://… bun run db:status:all
```

- `db:up:all` / `db:down:all` / `db:status:all` are the bring-up commands:
  they chain the three sets (`db:up && db:up:domain && db:up:api`, reversed for
  `down`). The per-set scripts stay for granular control — partial bring-up as
  each set's ticket lands, and per-set rollback (`db:down:api` rolls back just
  the product set without touching engine/domain).
- `NEON_DATABASE_URL` is the pooled connection string (hostname contains
  `-pooler`, `?sslmode=require`).
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

When a production Neon database is provisioned, apply the full v1 schema with
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

`src/rag-store-neon.test.ts` is an integration suite against a real Neon
database. It is **skipped unless `NEON_DATABASE_URL` is set**, so the default
`bun run test` job stays green without the secret. In CI these run in a
separate, secret-gated job with `--no-file-parallelism` (they share one
fixture namespace keyed off a per-run prefix, so parallel files would race).
The pure query builder (`rag-store-neon-query.ts`) and helpers
(`rag-store-shared.ts`) are unit-tested and run in every environment.