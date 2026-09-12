/**
 * migration-sql.mjs — SQL normalization for the migration runner
 * (`db-migrate.mjs`). Extracted so the rule is testable without spawning a
 * database: `tests/scripts/db-migrate.test.mjs` covers it.
 *
 * The one rule: a migration file may wrap itself in `BEGIN; … COMMIT;`, but
 * the runner owns the transaction (so a failed migration rolls its
 * `schema_migrations` row back with the DDL), so that wrapper is removed
 * before the body is sent.
 *
 * Why this is not a line-by-line sweep for `BEGIN`/`COMMIT` (the original
 * implementation, and a real defect): a PL/pgSQL block inside a
 * `DO $$ … $$` body legitimately contains a bare `BEGIN` line. Sweeping by
 * line silently deleted it, leaving an unterminated block that Postgres
 * rejected with `syntax error at or near "IF"` — the failure
 * `packages/kajianq-domain/migrations/0002_aligned_pairs.sql` hit the first
 * time it was applied to a real database. Only the *file-level* wrapper is
 * removed: the file's first statement and its last statement, ignoring
 * comments and blank lines.
 */

/** The two file-level transaction markers, as hardcoded regexes (`BEGIN;`/`COMMIT;`). */
const BEGIN_MARKER = /^\s*BEGIN\s*;?\s*$/i;
const COMMIT_MARKER = /^\s*COMMIT\s*;?\s*$/i;

/** True when a line carries only the given transaction keyword (plus `;`). */
function isTxnMarker(line, keyword) {
  return (keyword === "BEGIN" ? BEGIN_MARKER : COMMIT_MARKER).test(line);
}

/** True when a line carries no SQL: blank, or a `--` line comment. */
function isIgnorable(line) {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("--");
}

/** Index of the file's first statement line, or -1 when the file is empty. */
function firstStatementIndex(lines) {
  return lines.findIndex((line) => !isIgnorable(line));
}

/** Index of the file's last statement line, or -1 when the file is empty. */
function lastStatementIndex(lines) {
  return lines.reduce((last, line, i) => (isIgnorable(line) ? last : i), -1);
}

/**
 * Strip a migration file's own `BEGIN;`/`COMMIT;` wrapper, leaving every other
 * line — including PL/pgSQL `BEGIN`s inside dollar-quoted bodies — untouched.
 */
export function stripTxnMarkers(sql) {
  const lines = sql.split("\n");
  const first = firstStatementIndex(lines);
  if (first >= 0 && isTxnMarker(lines[first], "BEGIN")) {
    lines.splice(first, 1);
  }
  const last = lastStatementIndex(lines);
  if (last >= 0 && isTxnMarker(lines[last], "COMMIT")) {
    lines.splice(last, 1);
  }
  return lines.join("\n");
}
