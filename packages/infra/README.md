# infra — persistence & blob seams

Adapters the engine and apps consume; engine code never imports a database or
vendor client directly (ADR-0008, ADR-0009). What lives here:

- **`RagStore`** — (landed in #4) the single seam for all structured
  persistence: corpus chunks with dual embeddings, Traces, chat, anonymous
  sessions, feedback, Golden Set, eval, model configs. `rag-store.ts` defines
  the interface; `rag-store-neon.ts` is the Neon Postgres + pgvector
  implementation; `rag-store-shared.ts` holds the pure, DB-free helpers it
  composes. Engine/app code consumes the interface only.
- **`ObjectStore`** — R2. Holds raw source archives and `text_raw` backups.
- **`Logger` / `ConfigStore` / `RateLimiter`** — template runtime adapters.

## RagStore

`createNeonRagStore(sql)` takes the query object returned by
`neon(NEON_DATABASE_URL)` and returns a `RagStore`. All SQL in the repository
lives in `rag-store-neon.ts` and `migrations/`; nothing else may hold a DB
client or query (`check-boundary.mjs` enforces this).

- Anonymous sessions per ADR-0017: `createSession()` mints a 30-day Bearer
  token (stored SHA-256-hashed only); `resolveUserId(token)` resolves it;
  `deleteUserCascade(userId)` removes the user and everything they own via
  `ON DELETE CASCADE` (sessions, chat, feedback). The auth routes these feed
  are mounted in #10, not here.
- The dual embedding columns (`embedding_ar`, `embedding_id`) are queried via
  `similaritySearch(track, …)` so the AR-only vs. ID-fusion posture decided by
  the #9 benchmark is a query-layer switch, not a schema change (ADR-0013).

## Migrations (db-migrate)

First migration `migrations/0001_init.sql` creates the full v1 schema in one
apply/rollback-clean migration, with `0001_init.down.sql` as its rollback.

```sh
NEON_DATABASE_URL=postgres://… bun run db:status   # what's applied
NEON_DATABASE_URL=postgres://… bun run db:up       # apply pending
NEON_DATABASE_URL=postgres://… bun run db:down     # roll back the last one
```

- `NEON_DATABASE_URL` is the pooled connection string (hostname contains
  `-pooler`, `?sslmode=require`).
- Applied migrations are recorded in `schema_migrations(name)`; `up` is a
  no-op when nothing is pending.
- The terminology concept-graph tables (`concept`, `lemma`,
  `concept_relation`, `lemma_evidence`) follow ADR-0014's DDL, with one noted
  adaptation: `lemma_evidence.ayah_pair_id` is a plain `uuid` until #6 lands
  the aligned-ayah table, at which point it can be promoted to a real FK.
- Corpus sizing for the dual-vector schema is recorded in
  `docs/neon-sizing-issue-4.md`.

## One-off probes (results recorded in the #4 PR)

```sh
bun run db:probe:pg-search   # pg_search/BM25 availability on the plan (AC)
bun packages/infra/scripts/r2-verify.mjs   # R2 read/write from the CLI env (AC)
```

## Contract tests

`src/rag-store-neon.test.ts` is an integration suite against a real Neon
database. It is **skipped unless `NEON_DATABASE_URL` is set**, so plain
`bun run test` stays green without the secret; set the URL (and run the file
serially) to exercise the vector round-trip on both embedding tracks.
