-- 0002_eval_results_question_id_text.down.sql — narrow question_id back to uuid.
--
-- This deliberately FAILS while any row holds a non-uuid id (e.g. "gs-v0-019"),
-- rather than dropping or rewriting ledger rows to make the cast succeed. A
-- rollback cannot invent uuids for real fixture ids, so the operator decides what
-- happens to the evidence instead of the migration doing it silently.

BEGIN;

ALTER TABLE eval_results
  ALTER COLUMN question_id TYPE uuid USING question_id::uuid;

COMMIT;
