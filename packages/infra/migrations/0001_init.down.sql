-- 0001_init.down.sql — clean rollback of 0001_init.sql.
-- Drops in dependency order; every statement is idempotent (IF EXISTS).
-- Only the engine-schema tables are dropped here; the product-owned tables
-- (principle_index, golden_questions) and the domain-owned terminology
-- concept graph are rolled back by their own per-package down migrations.
--
-- NOTE: the pgvector extension is intentionally NOT dropped here. It is an
-- instance-level shared resource this database may not exclusively control
-- (other objects can depend on it, and on Neon it may be provisioned by an
-- admin role), so removing it would fail the whole rollback transaction.
-- Re-applying 0001_init.sql stays safe either way: it uses
-- CREATE EXTENSION IF NOT EXISTS.

BEGIN;

ALTER TABLE answer_traces   DROP CONSTRAINT IF EXISTS answer_traces_user_fk;
ALTER TABLE feedback         DROP CONSTRAINT IF EXISTS feedback_user_fk;
ALTER TABLE chat_sessions    DROP CONSTRAINT IF EXISTS chat_sessions_user_fk;
ALTER TABLE chat_messages    DROP CONSTRAINT IF EXISTS chat_messages_answer_trace_fk;

DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS model_configs;
DROP TABLE IF EXISTS eval_results;
DROP TABLE IF EXISTS eval_runs;
DROP TABLE IF EXISTS feedback;
DROP TABLE IF EXISTS answer_traces;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS chat_sessions;
DROP TABLE IF EXISTS concept_links;
DROP TABLE IF EXISTS doc_children;
DROP TABLE IF EXISTS doc_parents;

COMMIT;