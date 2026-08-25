-- 0001_init.sql — DARS engine schema (issue #4), one apply, one clean rollback.
--
-- Scope and rules this file honors:
--   * Domain-agnostic (AGENTS.md rule 1). This is the DARS *engine* schema:
--     corpus chunks, traces, chat, anonymous sessions, feedback, the generic
--     eval run/result ledger, and model configs. Product-owned tables were
--     originally placed here by ADR-0014 but are domain leakage into an engine
--     package; they have been relocated (ADR-0014 amendment):
--       - the bilingual terminology concept graph (concept / lemma /
--         concept_relation / lemma_evidence) → packages/kajianq-domain.
--       - principle_index + golden_questions → apps/api.
--     scripts/check-boundary.mjs scans this .sql for Islamic-domain
--     identifiers, so keep this file domain-free (incl. comments).
--   * Idempotent ingestion (AGENTS.md rule 11): doc_parents.source_key is
--     UNIQUE so re-running ingestion upserts by provenance key, and
--     doc_children are upserted by (parent_id, ordinal).
--   * Dual embeddings from the start (ADR-0013 amendment): each child chunk
--     carries embedding_primary (canonical) and embedding_fallback
--     (fusion), both VECTOR(1536), nullable until embedded. The column names
--     are role-based on purpose: KajianQ maps primary/fallback onto its AR/ID
--     language tracks at the domain-pack layer, so the engine schema stays
--     language-agnostic. Both columns exist from the start so the
--     primary-only vs. fusion retrieval posture stays a RagStore query-layer
--     switch, not a re-embed.
--   * Anonymous sessions per ADR-0017: users + sessions, distinct from
--     chat_sessions / chat_messages; 30-day Bearer tokens, cascade delete.
--   * answer_traces stores the @app/contracts Trace shape verbatim as JSONB
--     (ADR-0007) AND carries user_id so a user's traces cascade-delete with
--     the user on anonymous self-deletion (ADR-0007 amendment).

BEGIN;

-- Required for the embedding columns below. pgvector is available on Neon's
-- standard plans; probing is part of #4's verification steps.
CREATE EXTENSION IF NOT EXISTS vector;

-- --------------------------------------------------------------------------
-- Corpus: coarse parent documents and fine-grained, embeddable child chunks.
-- --------------------------------------------------------------------------

CREATE TABLE doc_parents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key  text NOT NULL UNIQUE,         -- idempotent upsert key (rule 11)
  title       text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX doc_parents_metadata_gin ON doc_parents USING gin (metadata);
CREATE INDEX doc_parents_source_key_idx ON doc_parents (source_key);

CREATE TABLE doc_children (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id     uuid NOT NULL REFERENCES doc_parents (id) ON DELETE CASCADE,
  text_raw      text NOT NULL,             -- immutable after insert (rule 11)
  text_ar       text NOT NULL,             -- primary/canonical layer
  text_id       text,                      -- secondary/fallback layer
  -- Structured identity of the chunk for the deterministic citation
  -- validator (spec §71). Opaque JSONB: the domain pack chooses the shape
  -- (source-type citation anchors differ); the engine stores and returns it
  -- verbatim, not a text column (shapes differ → forced re-parsing).
  citation      jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding_primary vector(1536),          -- nullable until embedded
  embedding_fallback vector(1536),         -- nullable until embedded
  ordinal       integer NOT NULL,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_id, ordinal)
);

-- ANN indexes on both embedding tracks. HNSW is preferred over IVFFlat here
-- because it needs no training pass, so ingestion stays idempotent and
-- re-runnable (AGENTS.md §2) without a manual REINDEX step.
CREATE INDEX doc_children_embedding_primary_hnsw
  ON doc_children USING hnsw (embedding_primary vector_cosine_ops);
CREATE INDEX doc_children_embedding_fallback_hnsw
  ON doc_children USING hnsw (embedding_fallback vector_cosine_ops);
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

-- Passage-level links between child chunks (curated, not inferred —
-- ADR-0016). rel_type is opaque; the domain pack defines its values. This is
-- a generic, term-agnostic structure and so stays in the engine schema.
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
-- Conversational surface v1 (distinct from auth `users`/`sessions` below).
-- --------------------------------------------------------------------------

CREATE TABLE chat_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid,                       -- FK wired after `users` exists (below)
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
  role            text NOT NULL,
  content         text NOT NULL,
  answer_trace_id uuid,                   -- FK wired after answer_traces exists
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chat_messages_session_created
  ON chat_messages (session_id, created_at);

-- --------------------------------------------------------------------------
-- Traceability (ADR-0007) and the feedback loop it anchors.
-- --------------------------------------------------------------------------

-- One row per answer. `trace` JSONB is the @app/contracts Trace shape
-- verbatim; `message_id` indexes it back to the chat surface. `user_id`
-- cascade-deletes the trace with its owner on anonymous self-deletion
-- (ADR-0007 amendment), so a user's Q&A record is erased with them.
CREATE TABLE answer_traces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  text NOT NULL UNIQUE,
  user_id     uuid,                       -- FK wired after `users` exists; CASCADE
  trace       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX answer_traces_created_at ON answer_traces (created_at);
CREATE INDEX answer_traces_user_id ON answer_traces (user_id);

ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_answer_trace_fk
  FOREIGN KEY (answer_trace_id) REFERENCES answer_traces (id) ON DELETE SET NULL;

CREATE TABLE feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  text NOT NULL,
  user_id     uuid,                       -- FK wired after `users` exists
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
-- Generic eval run/result ledger (spec §165). The curated question set
-- (golden_questions) is product-owned (apps/api), so question_id is a loose
-- uuid reference with no FK — mirroring the cross-boundary loose-reference
-- precedent — the eval harness resolves it through its own seam, not a
-- cross-schema FK.
-- --------------------------------------------------------------------------

CREATE TABLE eval_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label       text,
  report      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE eval_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES eval_runs (id) ON DELETE CASCADE,
  question_id   uuid NOT NULL,            -- loose ref to product golden_questions
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
  expires_at  timestamptz NOT NULL,       -- set by the adapter (30-day TTL, ADR-0017)
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

ALTER TABLE answer_traces
  ADD CONSTRAINT answer_traces_user_fk
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;

COMMIT;