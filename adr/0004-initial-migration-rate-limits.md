# ADR-0004: Initial-migration edit removing `rate_limits`

**Status:** accepted  
**Date:** 2026-07-30

## Context

`migrations/0000_init.sql` created a `rate_limits` table that no code path ever read or wrote — rate limiting is enforced in memory at the edge (`packages/infra` RateLimiter). Dead schema cloned into every fork is the same class of drift as dead code. Normally a live database would require a new migration to drop the table; this template is pre-production with no deployed data.

## Decision

The initial migration was edited in place to drop `rate_limits` (with a header comment recording the edit), rather than appending a second migration that creates-then-drops the table. The migration moved to `apps/api/migrations/` at the same time (raw SQL is the single database truth; `packages/db-schema` was deleted).

## Consequences

- Fresh clones and fresh D1 databases get the truthful schema in one migration.
- Existing local dev checkouts must reset their local database: delete `.wrangler/state` and re-run `bun run db:migrate:local`.
- Precedent boundary: in-place migration edits are acceptable **only** pre-production. Once a consuming project has deployed data, schema changes are strictly append-only migrations.
