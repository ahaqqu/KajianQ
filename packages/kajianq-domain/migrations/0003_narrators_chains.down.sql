-- 0003_narrators_chains.down.sql — roll back the narrator catalogue and the chains.
--
-- Drops the chain table first (its FK references doc_children, not the reverse),
-- then the narrator table. A table drop removes its own indexes and constraints, so
-- no separate DROP INDEX is needed. Nothing outside these two tables is touched:
-- v1 rows, embeddings, and the engine schema are unchanged.

BEGIN;

DROP TABLE IF EXISTS narrator_chains;
DROP TABLE IF EXISTS narrators;

COMMIT;
