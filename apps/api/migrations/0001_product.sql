-- 0001_product.sql — KajianQ product-owned schema tables (issue #4 amendment).
--
-- These tables encode KajianQ *product* concepts (the Principle Index and the
-- Golden Set, per CONTEXT.md) and so are owned by the app, not the engine
-- (AGENTS.md rule 1: engine packages contain ZERO product-domain logic). They
-- were originally placed in the engine migration (#4) and are relocated here.
-- The schema is self-contained (no FK to the engine schema), so it applies
-- and rolls back independently.
--
-- `golden_questions.question` and `principle_index.body` carry curated
-- content; `metadata` JSONB holds product-specific provenance.

BEGIN;

-- Principle Index: a small curated set of interpretive lenses, retrieved
-- alongside evidence so answers keep the big picture (CONTEXT.md).
CREATE TABLE principle_index (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  title       text NOT NULL,
  body        text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Golden Set: curated eval questions (spec §165). The generic eval run/result
-- ledger lives in the engine schema (packages/infra) and references these by
-- a loose uuid (no cross-schema FK), resolved through the eval harness seam.
CREATE TABLE golden_questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question    text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMIT;