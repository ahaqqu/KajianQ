-- 0001_init.sql — KajianQ v1 schema (issue #4), one apply, one clean rollback.
--
-- Scope and rules this file honors:
--   * Domain-agnostic. Column names never encode KajianQ domain vocabulary;
--     domain values travel inside `metadata` JSONB or as opaque filter values.
--   * Dual embeddings from the start (ADR-0013 amendment): each child chunk
--     carries `embedding_ar` (primary/canonical) and `embedding_id`
--     (fallback/fusion), both VECTOR(1536), nullable until embedded. Keeping
--     both columns from the first migration means the AR-only vs. ID-fusion
--     retrieval posture stays a RagStore query-layer switch, not a re-embed.
--   * Terminology concept graph per ADR-0014 (term-level): `concept`,
--     `lemma`, `concept_relation`, `lemma_evidence`. Column sets follow
--     ADR-0014's DDL verbatim.
--   * Anonymous sessions per ADR-0017: `users` + `sessions`, distinct from
--     `chat_sessions` / `chat_messages`; 30-day Bearer tokens, cascade delete.
--   * `answer_traces` stores the @app/contracts `Trace` shape verbatim as
--     JSONB (ADR-0007 amendment); the store never re-shapes it.

BEGIN;

-- Required for the embedding columns below. pgvector is available on Neon's
-- standard plans; probing is part of #4's verification steps.
CREATE EXTENSION IF NOT EXISTS vector;

-- --------------------------------------------------------------------------
-- Corpus: coarse parent documents and fine-grained, embeddable child chunks.
-- --------------------------------------------------------------------------

CREATE TABLE doc_parents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key  text NOT NULL,
  title       text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX doc_parents_metadata_gin ON doc_parents USING gin (metadata);

CREATE TABLE doc_children (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id     uuid NOT NULL REFERENCES doc_parents (id) ON DELETE CASCADE,
  text_raw      text NOT NULL,             -- immutable after insert
  text_ar       text NOT NULL,             -- primary/canonical layer
  text_id       text,                      -- secondary/fallback layer
  -- Structured identity of the chunk for the deterministic citation validator
  -- (spec §71: "every citation must exist in retrieved chunks"). Opaque JSONB:
  -- the domain pack chooses the shape (QS/HR/Kitab anchors differ); the engine
  -- stores and returns it verbatim. NOT a text column because the three
  -- citation shapes differ and a string would force re-parsing.
  citation      jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding_ar  vector(1536),              -- nullable until embedded
  embedding_id  vector(1536),              -- nullable until embedded
  ordinal       integer NOT NULL,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_id, ordinal)
);

-- ANN indexes on both embedding tracks. HNSW is preferred over IVFFlat here
-- because it needs no training pass, so ingestion stays idempotent and
-- re-runnable (AGENTS.md §2) without a manual REINDEX step.
CREATE INDEX doc_children_embedding_ar_hnsw
  ON doc_children USING hnsw (embedding_ar vector_cosine_ops);
CREATE INDEX doc_children_embedding_id_hnsw
  ON doc_children USING hnsw (embedding_id vector_cosine_ops);
CREATE INDEX doc_children_metadata_gin ON doc_children USING gin (metadata);
CREATE INDEX doc_children_parent_id_idx ON doc_children (parent_id);

-- Sparse/full-text over the secondary display layer, with the fallback for
-- BM25 ranking (`pg_search`) recorded in the #4 probe; the tsvector path is
-- built in from the start so retrieval has a working sparse channel either
-- way (spec §161).
CREATE INDEX doc_children_text_id_tsvector
  ON doc_children USING gin (to_tsvector('simple', coalesce(text_id, '')));

-- --------------------------------------------------------------------------
-- Curated retrieval structures.
-- --------------------------------------------------------------------------

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

-- Passage-level links between child chunks (curated, not inferred — ADR-0016).
-- Distinct from the term-level concept graph below.
CREATE TABLE concept_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id    uuid NOT NULL REFERENCES doc_children (id) ON DELETE CASCADE,
  target_id   uuid NOT NULL REFERENCES doc_children (id) ON DELETE CASCADE,
  rel_type    text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (child_id <> target_id),
  UNIQUE (child_id, target_id, rel_type)
);

-- --------------------------------------------------------------------------
-- Terminology concept graph (ADR-0014, term-level). DDL follows the ADR.
--
-- NOTE on lemma_evidence.ayah_pair_id: ADR-0014 leaves the aligned-ayah-pair
-- table as "TBD by #4/#6". #4 does not invent that table — the FK target is
-- #6's scope. To keep this migration self-contained and roll back cleanly
-- without referencing a table that does not exist yet, the column is stored
-- as `uuid NOT NULL` (not a foreign key), constrained by shape only. #6 will
-- add the aligned-pair table and can promote this to a true FK then.
-- --------------------------------------------------------------------------

CREATE TABLE concept (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  scheme      text,
  gloss_en    text,
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lemma (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id    uuid NOT NULL REFERENCES concept (id) ON DELETE CASCADE,
  lang          text NOT NULL,
  written_rep   text NOT NULL,
  translit      text,
  is_preferred  boolean NOT NULL DEFAULT true,
  pos           text,
  embedding     vector(1024),            -- candidate-retrieval embedding
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (concept_id, lang, written_rep)
);

CREATE INDEX lemma_embedding_hnsw
  ON lemma USING hnsw (embedding vector_cosine_ops);

CREATE TABLE concept_relation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         uuid NOT NULL REFERENCES concept (id) ON DELETE CASCADE,
  target_id         uuid NOT NULL REFERENCES concept (id) ON DELETE CASCADE,
  rel_type          text NOT NULL,
  evidence_ayah_ids uuid[],
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source_id <> target_id),
  UNIQUE (source_id, target_id, rel_type)
);

CREATE TABLE lemma_evidence (
  lemma_id      uuid NOT NULL REFERENCES lemma (id) ON DELETE CASCADE,
  ayah_pair_id  uuid NOT NULL,           -- promoted to FK by #6 (see note)
  PRIMARY KEY (lemma_id, ayah_pair_id)
);

-- --------------------------------------------------------------------------
-- Conversational surface v1 (distinct from auth `users`/`sessions` below).
-- --------------------------------------------------------------------------

CREATE TABLE chat_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid,                       -- FK added after `users` exists (below)
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
  role            text NOT NULL,
  content         text NOT NULL,
  answer_trace_id uuid,                   -- FK added after answer_traces exists
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chat_messages_session_created
  ON chat_messages (session_id, created_at);

-- --------------------------------------------------------------------------
-- Traceability (ADR-0007) and the feedback loop it anchors.
-- --------------------------------------------------------------------------

-- One row per answer. `trace` JSONB is the @app/contracts Trace shape
-- verbatim; `message_id` indexes it back to the chat surface.
CREATE TABLE answer_traces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  text NOT NULL UNIQUE,
  trace       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX answer_traces_created_at ON answer_traces (created_at);

ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_answer_trace_fk
  FOREIGN KEY (answer_trace_id) REFERENCES answer_traces (id) ON DELETE SET NULL;

CREATE TABLE feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  text NOT NULL,
  user_id     uuid,                       -- FK added after `users` exists
  rating      smallint NOT NULL CHECK (rating IN (-1, 1)),
  anchor_type text NOT NULL,
  anchor_id   text,
  category    text,
  free_text   text,
  status      text NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX feedback_status_created ON feedback (status, created_at);

-- --------------------------------------------------------------------------
-- Golden Set + eval harness results (spec §165).
-- --------------------------------------------------------------------------

CREATE TABLE golden_questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question    text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE eval_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label       text,
  report      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE eval_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES eval_runs (id) ON DELETE CASCADE,
  question_id   uuid NOT NULL REFERENCES golden_questions (id) ON DELETE CASCADE,
  answer_trace_id uuid REFERENCES answer_traces (id) ON DELETE SET NULL,
  outcome       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX eval_results_run_id ON eval_results (run_id);

-- --------------------------------------------------------------------------
-- Model configs mirror (spec §166). The config files are the source of
-- truth; this mirrors for admin display and per-query cost lookups.
-- --------------------------------------------------------------------------

CREATE TABLE model_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role        text NOT NULL,              -- e.g. router/generator/reviewer/cheap
  provider    text NOT NULL,              -- vendor allowlist, as config data (ADR-0009)
  model_id    text NOT NULL,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role, provider, model_id)
);

-- --------------------------------------------------------------------------
-- Anonymous sessions (ADR-0017) — owned tables, distinct from chat_sessions.
-- --------------------------------------------------------------------------

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL DEFAULT 'anonymous',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Bearer token plaintext never touches the DB; only the SHA-256 hash is
-- stored. Token expiry is enforced in the adapter on read.
CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_token_hash ON sessions (token_hash);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

-- Now that `users` exists, wire the deferred FKs.
ALTER TABLE chat_sessions
  ADD CONSTRAINT chat_sessions_user_fk
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;

ALTER TABLE feedback
  ADD CONSTRAINT feedback_user_fk
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;

COMMIT;
