-- 0004_narrator_write_keys.down.sql — reverse the write keys only; 0003's tables
-- and their read indexes are untouched, so downgrading leaves the read path
-- exactly as 0003 defined it.

BEGIN;

DROP INDEX narrator_chains_source_ref_idx;

DROP INDEX narrators_identity_key_idx;

ALTER TABLE narrators DROP CONSTRAINT narrators_identity_key_nonblank;

ALTER TABLE narrators DROP COLUMN identity_key;

COMMIT;
