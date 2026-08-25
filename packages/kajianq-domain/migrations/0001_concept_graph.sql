-- 0001_concept_graph.sql — bilingual terminology concept graph (ADR-0014).
--
-- This is the KajianQ *domain* schema, owned by the domain pack. It is
-- deliberately outside the engine boundary gate (AGENTS.md rule 1): the
-- terminology concept graph is product domain logic — Arabic↔Indonesian
-- religious vocabulary anchored to aligned Quran/hadith pairs — so it lives
-- here, not in packages/infra. ADR-0014 originally placed these four tables
-- in the engine migration (#4); that was domain leakage into an engine
-- package and is amended here (ADR-0014 amendment) by relocating them.
--
-- Column sets follow ADR-0014's DDL verbatim. The graph is self-contained:
-- no FK to the engine schema, so it applies and rolls back independently.
--
-- NOTE on lemma_evidence.ayah_pair_id: ADR-0014 leaves the aligned-ayah-pair
-- table as "TBD by #4/#6". #6 owns that table; until it exists the column is
-- `uuid NOT NULL` (no FK), constrained by shape only. #6 will add the
-- aligned-pair table and can promote this to a true FK then.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;  -- needed for lemma.embedding

-- language-neutral concept node (≈ skos:Concept / WordNet synset / ILI)
CREATE TABLE concept (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  scheme       text,
  gloss_en    text,
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- per-language lemma (≈ ontolex:LexicalEntry + canonical Form)
CREATE TABLE lemma (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id    uuid NOT NULL REFERENCES concept (id) ON DELETE CASCADE,
  lang          text NOT NULL,                  -- 'ar' | 'id' (BCP47)
  written_rep   text NOT NULL,                  -- 'جَنَّة' or 'surga'
  translit      text,                           -- 'jannah' (optional)
  is_preferred  boolean NOT NULL DEFAULT true,  -- ≈ prefLabel vs altLabel
  pos           text,                           -- optional
  embedding     vector(1024),                   -- BGE-M3, for candidate retrieval
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (concept_id, lang, written_rep)
);

CREATE INDEX lemma_embedding_hnsw
  ON lemma USING hnsw (embedding vector_cosine_ops);

-- typed SKOS-style relations between concepts
CREATE TABLE concept_relation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         uuid NOT NULL REFERENCES concept (id) ON DELETE CASCADE,
  target_id         uuid NOT NULL REFERENCES concept (id) ON DELETE CASCADE,
  rel_type          text NOT NULL,              -- broader|narrower|related|part_of
  evidence_ayah_ids uuid[],                    -- ayah pairs that justify this relation
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source_id <> target_id),
  UNIQUE (source_id, target_id, rel_type)
);

-- ties every lemma back to the aligned ayah pairs that justify it
CREATE TABLE lemma_evidence (
  lemma_id      uuid NOT NULL REFERENCES lemma (id) ON DELETE CASCADE,
  ayah_pair_id  uuid NOT NULL,           -- promoted to FK by #6 (see note)
  PRIMARY KEY (lemma_id, ayah_pair_id)
);

COMMIT;