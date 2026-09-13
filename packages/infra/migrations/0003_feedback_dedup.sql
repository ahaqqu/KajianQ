-- 0003_feedback_dedup.sql — one feedback verdict per (user, answer, element).
--
-- The feedback route (#13, ADR-0007) persisted every POST verbatim: repeating
-- a thumb or re-submitting the same flag multiplied rows in the admin review
-- queue (thermo-review A1), with no idempotency for a double-tap or a client
-- retry. This index makes one user's verdict on one element of one answer a
-- natural key: `anchor_id`/`category` are nullable (a thumb anchors the whole
-- answer with both NULL), and Postgres UNIQUE treats NULLs as distinct, so the
-- index keys on their COALESCE'd form. The adapter's `insertFeedback` upserts
-- ON CONFLICT with the same expression list — a repeat verdict updates
-- rating/free_text/timestamp in place instead of inserting a sibling row.
--
-- `user_id` stays out of the conflict-safe path when NULL (NULLs never
-- conflict): unattributed rows dedup exactly as badly as before, which is
-- acceptable — the route always attributes (the anonymous session's id).

BEGIN;

CREATE UNIQUE INDEX feedback_user_answer_anchor_key
  ON feedback (
    user_id,
    message_id,
    anchor_type,
    COALESCE(anchor_id, ''),
    COALESCE(category, '')
  );

COMMIT;
