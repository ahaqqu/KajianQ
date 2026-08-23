-- 0001_init.down.sql — clean rollback of 0001_init.sql.
-- Drops in dependency order; every statement is idempotent (IF EXISTS).

BEGIN;

ALTER TABLE feedback      DROP CONSTRAINT IF EXISTS feedback_user_fk;
ALTER TABLE chat_sessions DROP CONSTRAINT IF EXISTS chat_sessions_user_fk;
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_answer_trace_fk;

DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS model_configs;
DROP TABLE IF EXISTS eval_results;
DROP TABLE IF EXISTS eval_runs;
DROP TABLE IF EXISTS golden_questions;
DROP TABLE IF EXISTS feedback;
DROP TABLE IF EXISTS answer_traces;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS chat_sessions;
DROP TABLE IF EXISTS lemma_evidence;
DROP TABLE IF EXISTS concept_relation;
DROP TABLE IF EXISTS lemma;
DROP TABLE IF EXISTS concept;
DROP TABLE IF EXISTS concept_links;
DROP TABLE IF EXISTS principle_index;
DROP TABLE IF EXISTS doc_children;
DROP TABLE IF EXISTS doc_parents;

DROP EXTENSION IF EXISTS vector;

COMMIT;
