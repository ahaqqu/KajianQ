-- 0004_narrator_write_keys.sql — the natural keys that make the v2 write path
-- idempotent (ADR-0012).
--
-- 0003 created the narrator catalogue and the chain rows read-only: no write
-- path existed, so no row identity was needed. The ingestion writes them now,
-- and a re-run of the same source must not multiply a narrator or a chain. The
-- two keys below are that guarantee at the database layer, where a caller
-- cannot forget them.
--
-- Why additive and nullable: rows may already exist from a writer outside this
-- seam, and a backfill would have to invent a key for them. `identity_key` is
-- therefore nullable with a non-blank CHECK; a NULL key is a row this write path
-- cannot address (honest — the store was never told its identity), and NULLs do
-- not collide under a unique index. Every row this seam writes carries a key.
--
-- The chain key is the source's own address, not the child it is attached to:
-- reconciliation can refine which child an Isnad transmits, and that refinement
-- must move the row, never leave a duplicate behind on the old child. A NULL
-- source_ref is outside the key for the same reason as above, and the seam's
-- write methods refuse a chain row without an address.
--
-- Neither index rewrites a row: 0003's columns, constraints and read indexes are
-- untouched, so the read contract the adapter already implements is unchanged.

BEGIN;

-- --------------------------------------------------------------------------
-- Narrators: the caller's identity key is the upsert target.
-- --------------------------------------------------------------------------

ALTER TABLE narrators ADD COLUMN identity_key text;

ALTER TABLE narrators
  ADD CONSTRAINT narrators_identity_key_nonblank
  CHECK (identity_key IS NULL OR btrim(identity_key) <> '');

-- One row per identity key. Not on the name: two narrators may share a name, and
-- identity is the ingestion's to settle (CONTEXT.md "Narrator").
CREATE UNIQUE INDEX narrators_identity_key_idx ON narrators (identity_key);

-- --------------------------------------------------------------------------
-- Chains: the source address is the upsert target.
-- --------------------------------------------------------------------------

CREATE UNIQUE INDEX narrator_chains_source_ref_idx
  ON narrator_chains (collection, source_ref)
  WHERE source_ref IS NOT NULL;

COMMIT;
