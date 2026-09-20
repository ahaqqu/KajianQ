/**
 * lib.mjs — the parts of the VPS backup/restore tooling that are worth testing
 * without a database (#180, ADR-0043 decision 4).
 *
 * Everything here is pure: retention policy, manifest shape and validation,
 * the erasure SQL a restore must re-apply, and small parsing helpers. The
 * CLIs (`kajianq-backup.mjs`, `kajianq-restore.mjs`) shell out to `restic` and
 * the libpq tools; the drill (`restore-drill.mjs`) drives both against a
 * scratch cluster. Keeping the decisions in one module is what lets the tests
 * assert them directly instead of only through a running server.
 *
 * The retention numbers are ADR-0043 decision 4 verbatim, and the ADR is the
 * source of truth: 30-day rolling encrypted backups, a restore re-applies
 * erasure. A change there changes these constants in the same PR.
 */

/** Rolling backup window in days — the anonymous-session TTL (ADR-0043). */
export const BACKUP_KEEP_DAILY = 30;

/** Access-log / Postgres-log / journald window in days (ADR-0043 decision 4). */
export const LOG_RETENTION_DAYS = 14;

/** A backup label: lowercase, digits and dashes, like the snapshot labels. */
export const LABEL_RE = /^[a-z0-9][a-z0-9-]{2,60}$/;

/** Throw with a prefixed message — every CLI failure goes through here. */
export function fail(msg) {
  throw new Error(msg);
}

/** Validate a backup label. */
export function readLabel(label) {
  if (!label) fail("a backup label is required (e.g. daily-20260919T031500Z)");
  if (!LABEL_RE.test(label)) {
    fail(`label "${label}" must match ${LABEL_RE} — lowercase, digits and dashes only`);
  }
  return label;
}

/**
 * restic args for the rolling retention. `forget --keep-daily 30 --prune`
 * keeps one snapshot per day for 30 days and deletes older ones for real — the
 * "30-day rolling" the ADR fixes, and the only deletion path (a snapshot is
 * never overwritten in place; its label is immutable, mirroring the corpus
 * snapshot rule in ADR-0038).
 */
export function retentionArgs(keepDaily = BACKUP_KEEP_DAILY) {
  if (!Number.isInteger(keepDaily) || keepDaily < 1) fail("keepDaily must be a positive integer");
  return ["forget", "--keep-daily", String(keepDaily), "--prune"];
}

/** The restic tag that names a backup label. */
export function labelTag(label) {
  return `label:${readLabel(label)}`;
}

/**
 * sha256 of a byte buffer as lowercase hex. Uses WebCrypto, so this runs on
 * both bun and node without importing `node:crypto`.
 */
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the manifest recorded next to a dump. `source` deliberately carries
 * host and database name only — never credentials, and never a real hostname
 * in a committed file (the manifest is generated on the host, not checked in).
 */
export function buildManifest({ label, bytes, sha256, counts, source, tool, git }) {
  return {
    label: readLabel(label),
    createdAt: new Date().toISOString(),
    tool,
    git: git ?? { sha: "unknown", branch: "unknown" },
    source,
    dump: { file: `kajianq-${label}.dump`, bytes, sha256 },
    tableCounts: counts,
  };
}

/** Validate a manifest read back from a snapshot; throw on anything missing. */
export function assertManifest(manifest) {
  if (!manifest || typeof manifest !== "object") fail("manifest is not an object");
  if (!LABEL_RE.test(String(manifest.label ?? ""))) fail("manifest has no valid label");
  const dump = manifest.dump;
  if (!dump || typeof dump.sha256 !== "string" || dump.sha256.length !== 64) {
    fail("manifest has no dump sha256");
  }
  if (!Number.isInteger(dump.bytes) || dump.bytes <= 0) fail("manifest has no dump size");
  if (!manifest.tableCounts || typeof manifest.tableCounts !== "object") {
    fail("manifest has no tableCounts");
  }
  return manifest;
}

/**
 * Verify a freshly restored database against its manifest. `actual` is
 * `{ bytes, sha256, counts }`.
 *
 * Every table the manifest records must match exactly. That is stricter than
 * the corpus-snapshot CLI's rule (`pg-conn.mjs`'s CORPUS_TABLES partition), and
 * deliberately so: that CLI compares a manifest against a LIVE database that
 * legitimately moves on, while here the target is a fresh restore of the very
 * archive the manifest describes, with nothing else writing to it. Any
 * difference means the restore is not faithful — a truncated archive, a
 * dropped table, a version mismatch — so there is no table whose drift is
 * benign on this path.
 *
 * Call it BEFORE re-applying erasure: post-erasure counts differ from the
 * manifest by design (that is the point of the erasure step).
 *
 * Returns `{ ok, reasons }`; `reasons` is empty exactly when `ok` is true.
 */
export function verifyRestore(manifest, actual) {
  assertManifest(manifest);
  const reasons = [];
  if (actual.bytes !== manifest.dump.bytes) {
    reasons.push(`size mismatch: manifest ${manifest.dump.bytes}, restored ${actual.bytes}`);
  }
  if (actual.sha256 !== manifest.dump.sha256) {
    reasons.push(`sha256 mismatch: manifest ${manifest.dump.sha256}, restored ${actual.sha256}`);
  }
  for (const [table, expected] of Object.entries(manifest.tableCounts)) {
    const got = actual.counts[table];
    if (got === undefined) {
      reasons.push(`${table} is absent in the restore (manifest ${expected})`);
    } else if (got !== expected) {
      reasons.push(`${table} manifest=${expected} restored=${got}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * The erasure a restore must re-apply (ADR-0043 decision 4: "after a restore
 * the reclamation/erasure path is re-run for the affected window — otherwise a
 * restored row would silently resurrect data the live store had deleted").
 *
 * The first two statements are `cleanupExpiredSessions` from
 * `packages/infra/src/rag-store-postgres-session.ts` verbatim: expired tokens, plus
 * the anonymous `users` left with no session (the FK cascade runs user →
 * session, never the reverse, so the second DELETE is what removes the chat /
 * trace / feedback subtree). The third is the Art. 17 path
 * (`deleteUserCascade`), used for a subject request that arrived after the
 * backup was taken.
 */
export const RECLAIM_SQL = [
  "DELETE FROM sessions WHERE expires_at <= now()",
  "DELETE FROM users WHERE kind = 'anonymous' AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.user_id = users.id)",
];

/**
 * The Art. 17 cascade — the same statement production `deleteUserCascade`
 * runs (`packages/infra/src/rag-store-postgres-session.ts`), with the user id
 * bound, never interpolated into the statement text. The id travels as a psql
 * variable (`-v uid=…` + `:'uid'`), so it is quoted by psql and the statement
 * text is fixed — a unit test normalizes this statement and the adapter's to
 * the same text, so the restore path cannot drift from production erasure.
 */
export function erasureSql() {
  return "DELETE FROM users WHERE id = :'uid'";
}

/** psql args binding the user id for `erasureSql()`; a non-UUID is refused. */
export function erasurePsqlArgs(userId) {
  if (!/^[0-9a-fA-F-]{36}$/.test(String(userId ?? ""))) fail("erasure needs a UUID user id");
  return ["-v", `uid=${String(userId)}`];
}

/**
 * The database LOCATION a connection URL names — protocol, host, port (5432
 * when omitted) and database name. Credentials and query parameters are
 * dropped: sslmode and friends change how a connection is made, not which
 * database it reaches. Throws on anything that is not a parseable
 * postgres:// URL, so a comparison built on it fails closed.
 */
export function dbLocation(url) {
  let u;
  try {
    u = new URL(String(url ?? ""));
  } catch {
    fail(`not a parseable connection URL: ${JSON.stringify(String(url ?? ""))}`);
  }
  const protocol = u.protocol === "postgresql:" ? "postgres:" : u.protocol;
  if (protocol !== "postgres:") fail(`not a postgres:// URL (got ${u.protocol})`);
  const database = (u.pathname || "").replace(/^\//, "") || "postgres";
  return { protocol, host: u.hostname, port: u.port || "5432", database };
}

/**
 * True when two connection URLs name the same database, even when written
 * differently (default port omitted, postgresql:// scheme, other credentials
 * or query order). This is the `--target-url`-must-not-be-the-live-URL guard:
 * string equality would both miss an equal database written differently and
 * compare secrets. Used by kajianq-restore.mjs to refuse restoring over the
 * live store (ADR-0043 decision 4).
 */
export function isSameDatabase(a, b) {
  const key = (url) => {
    const l = dbLocation(url);
    return `${l.protocol}|${l.host}|${l.port}|${l.database}`;
  };
  return key(a) === key(b);
}

/** Compact rows/tables line for console output. */
export function formatCounts(counts, limit = 8) {
  const entries = Object.entries(counts).slice(0, limit);
  return entries.map(([table, n]) => `${table}=${n}`).join(" ");
}

/**
 * Parse `key=value` lines (an env file) into an object, skipping blanks and
 * `#` comments. Used for `--env-file` so a CLI never has to export credentials
 * into a shell, and so the tests can exercise parsing without a filesystem.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Required credential keys, named (not read) so a missing one is actionable. */
export const REQUIRED_ENV = ["RESTIC_REPOSITORY", "RESTIC_PASSWORD_FILE", "PGDATABASE_URL"];

/** Return the subset of REQUIRED_ENV that is absent or empty. */
export function missingEnv(env) {
  return REQUIRED_ENV.filter((k) => !env?.[k]);
}
