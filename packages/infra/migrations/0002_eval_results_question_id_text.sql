-- 0002_eval_results_question_id_text.sql — eval_results.question_id must be text.
--
-- The Golden Set's ids are stable, human-readable strings ("gs-v0-019"). They are
-- the ids in the fixture, in the run report, and in every per-question ledger row
-- the harness writes. The column was declared `uuid` with a "loose ref to product
-- golden_questions" comment, so EVERY `saveResult` failed with `invalid input
-- syntax for type uuid` — and because the harness counted a ledger failure as a
-- skipped question, the smoke reported two phantom skips for two questions and
-- could never go green. `eval_results` stayed empty (verified: 0 rows) while
-- ADR-0034 claimed per-question rows.
--
-- The table is empty, so the cast is trivially safe. `golden_questions.id` stays
-- uuid: that table is the product's own curated store (currently empty), the
-- reference is loose in both directions, and the id space actually in use is the
-- fixture's.

BEGIN;

ALTER TABLE eval_results
  ALTER COLUMN question_id TYPE text USING question_id::text;

COMMIT;
