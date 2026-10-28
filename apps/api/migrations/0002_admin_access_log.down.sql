-- 0002_admin_access_log.down.sql — clean rollback of 0002_admin_access_log.sql.
-- Idempotent (IF EXISTS).

BEGIN;

DROP TRIGGER IF EXISTS admin_access_log_append_only ON admin_access_log;
DROP FUNCTION IF EXISTS admin_access_log_guard();
DROP INDEX IF EXISTS admin_access_log_accessed_at;
DROP TABLE IF EXISTS admin_access_log;

COMMIT;
