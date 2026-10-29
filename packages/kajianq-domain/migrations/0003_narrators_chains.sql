-- 0003_narrators_chains.sql — the narrator catalogue and the per-chain rows (ADR-0012).
--
-- v2 turns hadith grading from one flattened grade per matn into per-chain grades
-- with grader attribution (ADR-0012, SPECS.md §9). This migration adds the two
-- tables that carry the transmission evidence — `narrators` and `narrator_chains` —
-- and nothing else: v1 rows, embeddings, and indexes are untouched, there is no
-- re-ingestion and no re-indexing.
--
-- Why the domain pack owns these tables: they are product domain logic (hadith
-- narrators, the isnad that transmits a matn, and its graders), so they live here
-- by ADR-0014/ADR-0019, not in the engine schema. The engine's `doc_children` rows
-- are the retrieval view of the same hadith; a chain attaches to one child.
--
-- Why `narrator_chains` and not `hadith_chains`: the `RagStore` adapter is the
-- only place SQL lives (ADR-0008), and it sits in an engine package where the
-- boundary gate forbids Islamic-domain vocabulary — `hadith` is on that list
-- (ADR-0019). The physical name is therefore role-based, exactly as
-- `aligned_pairs` names its language tracks `text_primary`/`text_secondary`
-- (ADR-0013): the domain pack binds `narrator_chains` to its isnad type at its
-- own boundary, so the engine adapter names no domain concept.
--
-- This migration applies AFTER the engine set, because `child_id` references
-- `doc_children` (ON DELETE CASCADE: a chain dies with the hadith it transmits).
-- `bun run db:up:all` is the supported order; the ledger itself does not enforce
-- cross-set order.
--
-- Invariants the DDL enforces (each one is a silent-failure guard, not a preference):
--   * a chain has at least one narrator and no NULL element — an empty or
--     half-ordered chain is not transmission evidence;
--   * a grade is one of CONTEXT.md's four, or NULL — no typo'd/unknown grade can
--     reach a citation;
--   * grade and grader travel together — ADR-0012 requires grader attribution, so
--     an unattributed grade cannot be stored;
--   * narrators are never UNIQUE by name: two different narrators can share a
--     name, and resolving identity is the ingestion's job (S2), not a string's.
--
-- Not enforced here, by design: `narrator_ids uuid[]` cannot carry a foreign key,
-- so a chain may name a narrator with no row. Reads return the ids verbatim; the
-- narrator by-id read omits unknown ids, so a consumer can detect an unresolved
-- reference instead of silently losing it. Ingestion writes narrators before
-- chains.
--
-- Insertion order is carried by `narrator_chains.seq`, an identity column: values
-- are allocated in the order the inserts run, which is the order one ingestion
-- transaction supplies a child's chains. `created_at` is the transaction
-- timestamp (one value for the whole batch) and `id` is random, so neither can
-- provide that order; the child read orders by `seq` through its composite index.

BEGIN;

-- --------------------------------------------------------------------------
-- Narrators: one row per resolved transmitter (rawi), not per name surface.
-- --------------------------------------------------------------------------

CREATE TABLE narrators (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The ingested canonical spelling. Not UNIQUE: two narrators can share a name
  -- (that ambiguity is exactly what entity resolution exists to settle), and a
  -- name-based constraint would force a false merge at write time.
  canonical_name_ar      text NOT NULL,
  -- Every other spelling the resolution saw for this narrator; a lookup matches
  -- the canonical name or any variant. Duplicates are harmless.
  name_variants          text[] NOT NULL DEFAULT '{}'::text[],
  kunya                  text,
  laqab                  text,
  -- Hijri death year. NULL means unknown, never a sentinel: a 0 or negative year
  -- would read as a real date, so it is rejected below.
  death_year             integer,
  -- The generation as the source states it (a label, not a level): the
  -- classification systems differ between critics, so a bare integer would imply
  -- a system the row does not record.
  tabaqa                 text,
  -- Critic key -> that critic's assessment of this narrator (jarh wa ta'dil).
  -- Opaque to the engine seam: stored and returned verbatim, like `metadata`; the
  -- domain pack owns the value shape and its provenance.
  reliability_by_critic  jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (btrim(canonical_name_ar) <> ''),
  CHECK (array_position(name_variants, NULL) IS NULL),
  CHECK (death_year IS NULL OR death_year > 0)
);

-- Exact canonical-name lookup (the engine's name read's first branch).
CREATE INDEX narrators_canonical_name_idx ON narrators (canonical_name_ar);
-- Variant lookup: `name_variants @> ARRAY[$1]`. GIN is the array-containment index.
CREATE INDEX narrators_name_variants_gin ON narrators USING gin (name_variants);

-- --------------------------------------------------------------------------
-- Chains: one isnad attached to one child chunk.
-- --------------------------------------------------------------------------

CREATE TABLE narrator_chains (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The store-assigned insertion order. `created_at` is the transaction timestamp
  -- and `id` is random, so neither can order the chains one ingestion transaction
  -- writes for a child; identity values are allocated in the order the inserts run.
  seq           bigint GENERATED ALWAYS AS IDENTITY,
  -- The hadith child this chain transmits. The cascade is the ownership rule: a
  -- child's removal removes its transmission evidence, never the narrator
  -- catalogue (narrators are shared across chains and outlive any one child).
  child_id      uuid NOT NULL REFERENCES doc_children (id) ON DELETE CASCADE,
  -- The collection the chain comes from. Its vocabulary is the domain pack's
  -- (like `concept_links.rel_type`), so no CHECK pins it here.
  collection    text NOT NULL,
  -- The ordered chain. Order IS the isnad: the array is stored and returned
  -- exactly as ingested, duplicates included (a source row may concatenate
  -- parallel isnads into one list, so the same narrator can legitimately appear
  -- twice in one chain).
  narrator_ids  uuid[] NOT NULL,
  -- Per-chain authenticity classification (CONTEXT.md: mutawatir | sahih |
  -- hasan | dhaif). NULL until a grader's verdict exists; Sanadset itself
  -- carries no grade.
  grade         text,
  -- The scholar whose verdict the grade is (ADR-0012: per-chain, with grader
  -- attribution).
  grader        text,
  -- Provenance of the chain row: the source's own address for it. Nullable
  -- because a reconciled chain may have no single source address.
  source_ref    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT narrator_chains_nonempty CHECK (cardinality(narrator_ids) > 0),
  CONSTRAINT narrator_chains_no_null_narrator CHECK (array_position(narrator_ids, NULL) IS NULL),
  CONSTRAINT narrator_chains_collection_nonempty CHECK (btrim(collection) <> ''),
  CONSTRAINT narrator_chains_grade_vocabulary
    CHECK (grade IS NULL OR grade IN ('mutawatir', 'sahih', 'hasan', 'dhaif')),
  -- A grade without its grader is the flattened per-matn problem ADR-0012
  -- rejects, a grader without a grade states nothing, and a blank grader is an
  -- unattributed grade wearing a string.
  CONSTRAINT narrator_chains_grade_attribution CHECK (
    (grade IS NULL) = (grader IS NULL) AND (grader IS NULL OR btrim(grader) <> '')
  )
);

-- The chain -> child join, ordered by the store-assigned insertion sequence: the
-- composite lets the read filter and order in one index scan, and keeps multiple
-- chains presented neutrally (insertion order, never a grade ranking).
CREATE INDEX narrator_chains_child_id_idx ON narrator_chains (child_id, seq);
-- The keyset page over one collection, ordered by the opaque id cursor.
CREATE INDEX narrator_chains_collection_idx ON narrator_chains (collection, id);

COMMIT;
