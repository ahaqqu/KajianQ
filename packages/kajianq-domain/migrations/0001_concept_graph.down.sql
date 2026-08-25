-- 0001_concept_graph.down.sql — clean rollback of 0001_concept_graph.sql.
-- Idempotent (IF EXISTS); drops in dependency order.

BEGIN;

DROP TABLE IF EXISTS lemma_evidence;
DROP TABLE IF EXISTS concept_relation;
DROP TABLE IF EXISTS lemma;
DROP TABLE IF EXISTS concept;

-- Do NOT drop the `vector` extension here: it is owned by the engine schema
-- (packages/infra/migrations/0001_init.sql), which may still be applied.

COMMIT;