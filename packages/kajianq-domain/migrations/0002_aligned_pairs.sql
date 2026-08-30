-- 0002_aligned_pairs.sql — the aligned-pair table owned by #6.
--
-- ADR-0014 left `lemma_evidence.ayah_pair_id` as a loose `uuid NOT NULL`
-- (no FK) "pending #6's aligned-ayah table". This migration adds that table
-- and promotes the reference to a true FK.
--
-- Why it lives here (domain pack), not in the engine schema: the aligned
-- pair is product domain logic — an (Arabic, Indonesian) Quran verse pair
-- keyed by Tanzil numbering, consumed by the terminology concept-graph build
-- (#24). The engine's `doc_children` rows hold the retrieval view of the
-- same verse; this table is the *alignment* view (pair id + both language
-- tracks + per-token morphology), and the two are joined by citation
-- metadata, not a cross-schema FK — mirroring the loose-reference precedent
-- (eval_results.question_id) already recorded for cross-boundary links.
--
-- Morphology is stored verbatim from the Quranic Arabic Corpus (GPL,
-- ADR-0014): stored per-token alongside the Arabic text; corrections to the
-- corpus itself are a separate layer and never written back here.
--
-- Column names are role-based (`text_primary`/`text_secondary`) to match the
-- engine seam's ADR-0013 role vocabulary — the domain pack binds the roles
-- to its AR/ID language tracks at its boundary, so the same table serves any
-- second consumer of DARS without inheriting KajianQ's language codes.
--
-- Idempotent ingestion (AGENTS.md rule 11): `pair_key` is UNIQUE so
-- re-running ingestion upserts by provenance key; text columns are refreshed
-- on conflict but the source-of-truth archive lives in R2 (raw bytes, never
-- committed to the repo).

BEGIN;

CREATE TABLE aligned_pairs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pair_key      text NOT NULL UNIQUE,         -- idempotent upsert key (domain-supplied)
  citation      jsonb NOT NULL,               -- opaque pair address (domain shape)
  text_primary  text NOT NULL,                -- canonical evidence track (ADR-0013)
  text_secondary text NOT NULL,               -- display/fallback track (ADR-0013)
  morphology    jsonb NOT NULL DEFAULT '[]'::jsonb,  -- MorphToken[] (lemma+root per token)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX aligned_pairs_citation ON aligned_pairs (citation);

-- Promote lemma_evidence.ayah_pair_id to a true FK now that the table
-- exists (ADR-0014 amendment). Existing rows (none yet — the graph build is
-- #24) would be validated by the constraint; the promotion is safe because
-- the column was constrained by shape only until now.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'lemma_evidence_ayah_pair_fk'
  ) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'lemma_evidence') THEN
    ALTER TABLE lemma_evidence
      ADD CONSTRAINT lemma_evidence_ayah_pair_fk
      FOREIGN KEY (ayah_pair_id) REFERENCES aligned_pairs (id) ON DELETE CASCADE;
  END IF;
END $$;

COMMIT;