-- Initial schema. Edited 2026-07-28 (WS1): dropped the unused rate_limits
-- table (rate limiting is in-memory via @app/infra RateLimiter). Template is
-- pre-production, so the initial migration was rewritten instead of adding a
-- new one — existing local dev DBs must be reset: delete `.wrangler/state`
-- and re-run `bun run db:migrate:local`.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS notes_user_id_idx ON notes (user_id);
