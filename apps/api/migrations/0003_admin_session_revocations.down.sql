-- 0003_admin_session_revocations.down.sql — clean rollback of
-- 0003_admin_session_revocations.sql. Idempotent (IF EXISTS).

BEGIN;

DROP INDEX IF EXISTS admin_session_revocations_expires_at;
DROP TABLE IF EXISTS admin_session_revocations;

COMMIT;
