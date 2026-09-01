-- 0002_aligned_pairs.down.sql — roll back the aligned-pair table.
--
-- Drops the FK first (it references the table being dropped), then the
-- table itself. lemma_evidence.ayah_pair_id returns to the loose-uuid state
-- it had before ADR-0014's pending promotion.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'lemma_evidence_ayah_pair_fk'
  ) THEN
    ALTER TABLE lemma_evidence DROP CONSTRAINT lemma_evidence_ayah_pair_fk;
  END IF;
END $$;

DROP TABLE IF EXISTS aligned_pairs;

COMMIT;