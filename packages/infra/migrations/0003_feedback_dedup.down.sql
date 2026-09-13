-- 0003_feedback_dedup.down.sql — drop the one-verdict-per-element key.
-- Re-inserted duplicate verdicts (pre-0003 posture) come back; existing
-- duplicates that violate the index would have blocked 0003's up, so the down
-- is always applicable.

BEGIN;

DROP INDEX IF EXISTS feedback_user_answer_anchor_key;

COMMIT;
