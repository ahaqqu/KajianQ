-- 0003_admin_session_revocations.sql — the admin session revocation denylist.
--
-- The admin session is a signed, stateless token (ADR-0064). A sign-out must end it
-- for every instance serving the surface, not only clear the browser's copy, so the
-- one piece of server-side state the session model keeps is this denylist: the token's
-- random session id (`jti`) and the expiry the token itself carries. A read verifies
-- the signature, then asks this table; a row here is the same miss as an expired or
-- forged token, and every other session id stays untouched.
--
-- The rows carry no credential, no user and no content — only a random id and the
-- revoked token's own `exp` — so the table cannot become an identity store. A row is
-- reclaimed by the first nightly cleanup after the token it ends has expired: the
-- token's lifetime plus at most one cleanup interval, so it outlives its token by
-- design. The signature's expiry check refuses that token with or without the row, so
-- the row proves nothing after `expires_at`.

BEGIN;

CREATE TABLE admin_session_revocations (
  jti        text PRIMARY KEY CHECK (jti <> ''),
  -- The revoked token's `exp`: the purge deletes the row at the first cleanup after it,
  -- so the row outlives its token by at most one cleanup interval.
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now()
);

-- The purge's predicate; a lookup by token id uses the primary key.
CREATE INDEX admin_session_revocations_expires_at ON admin_session_revocations (expires_at);

COMMIT;
