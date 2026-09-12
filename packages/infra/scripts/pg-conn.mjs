/**
 * pg-conn.mjs — libpq plumbing for the infra CLIs (`db-snapshot.mjs` today).
 * Split out of the entry point for the same reason `migration-sql.mjs` is split
 * out of `db-migrate.mjs`: the CLI stays a thin composition root and its line
 * and import counts stay inside the agentic-limits cap.
 *
 * Credentials travel as libpq `PG*` env vars, never as argv: `PGDATABASE` takes
 * a database *name*, not a conninfo string — libpq only expands a conninfo
 * string for the `dbname` parameter itself — so the URL is decomposed here.
 * That also keeps the password out of the process table.
 */
import { spawnSync } from "node:child_process";

const TABLE_COUNTS_SQL =
  "SELECT relname || '|' || (xpath('/row/c/text()', query_to_xml(" +
  "'SELECT count(*) AS c FROM ' || quote_ident(relname), false, true, '')))[1]::text " +
  "FROM pg_stat_user_tables ORDER BY relname";

/** Tables whose exact row counts are recorded in a snapshot manifest. */
const SNAPSHOTABLE = [
  "doc_parents",
  "doc_children",
  "aligned_pairs",
  "eval_runs",
  "eval_results",
  "answer_traces",
  "chat_messages",
  "chat_sessions",
  "users",
  "sessions",
  "model_configs",
  "schema_migrations",
];

/** Run a command and return trimmed stdout; throws with stderr on any failure. */
export function run(cmd, args, env = {}) {
  const res = spawnSync(cmd, args, { env: { ...process.env, ...env }, encoding: "utf8" });
  if (res.error) throw new Error(`${cmd} could not run: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`${cmd} exited ${res.status}: ${(res.stderr || "").trim()}`);
  }
  return (res.stdout || "").trim();
}

/** Decompose a connection URL into the libpq environment. */
export function pgEnv(url) {
  const u = new URL(url);
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: (u.pathname || "").replace(/^\//, "") || "postgres",
    PGSSLMODE: u.searchParams.get("sslmode") ?? "require",
  };
}

/** Query the database; credentials travel via env, never argv. */
export function sql(url, statement) {
  return run("psql", ["-At", "-v", "ON_ERROR_STOP=1", "-c", statement], pgEnv(url));
}

/** Exact row counts for the snapshot-relevant tables, as a plain object. */
export function tableCounts(url) {
  const counts = {};
  for (const line of sql(url, TABLE_COUNTS_SQL).split("\n")) {
    const [name, n] = line.split("|");
    if (name && SNAPSHOTABLE.includes(name)) counts[name] = Number(n);
  }
  return counts;
}
