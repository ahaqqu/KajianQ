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
-- revoked token's own `exp` — so the table cannot become an identity store. Its
-- retention is the token's lifetime: after `expires_at`, the signature's expiry check
-- refuses the token with or without the row, and the nightly cleanup deletes the row.

BEGIN;

CREATE TABLE admin_session_revocations (
  jti        text PRIMARY KEY CHECK (jti <> ''),
  -- The revoked token's `exp`, so the row outlives exactly the token it ends.
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now()
);

-- The purge's predicate; a lookup by token id uses the primary key.
CREATE INDEX admin_session_revocations_expires_at ON admin_session_revocations (expires_at);

COMMIT;
