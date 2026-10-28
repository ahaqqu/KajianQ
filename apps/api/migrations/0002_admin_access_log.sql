-- 0002_admin_access_log.sql — the admin Trace browser's append-only access log.
--
-- The admin surface reads chat content (questions, answers, persisted traces),
-- which is personal data and can reveal religious convictions (RoPA §5), so a
-- read is recorded before it is served (ADR-0064). The table deliberately has NO
-- column for a question, an answer, a trace body or a free-text filter: the
-- filter summary records the dimensions a read was narrowed by, and the one
-- content-shaped input — the operator's search text — is recorded only as the
-- fact that a text filter ran. There is no column a question could be written
-- into, so the log cannot accumulate chat content by accident.
--
-- Append-only is a database rule, not a caller convention: an UPDATE always
-- raises, and a DELETE raises while the row is younger than the retention window.
-- The retention window below is what makes the published retention value true; it
-- is the same window `purgeAdminAccessLog` deletes by, and the real-Postgres
-- contract suite pins the pair together.

BEGIN;

CREATE TABLE admin_access_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  accessed_at    timestamptz NOT NULL DEFAULT now(),
  -- A stable, keyed pseudonym of the credential that performed the read: "who".
  actor          text NOT NULL CHECK (actor <> ''),
  -- The route that was read, e.g. `traces.list` — "what", with the summary below.
  route          text NOT NULL CHECK (route <> ''),
  -- The filter dimensions and page, never the text searched for — "what filter".
  filter_summary jsonb NOT NULL DEFAULT '{}'::jsonb
                 CHECK (jsonb_typeof(filter_summary) = 'object')
);

CREATE INDEX admin_access_log_accessed_at ON admin_access_log (accessed_at);

CREATE FUNCTION admin_access_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'admin_access_log is append-only: an access record is never rewritten';
  END IF;
  IF OLD.accessed_at > now() - interval '90 days' THEN
    RAISE EXCEPTION
      'admin_access_log is append-only: a record younger than its 90-day retention window is never deleted';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER admin_access_log_append_only
  BEFORE UPDATE OR DELETE ON admin_access_log
  FOR EACH ROW EXECUTE FUNCTION admin_access_log_guard();

COMMIT;
