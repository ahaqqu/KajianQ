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

/**
 * The subset of `SNAPSHOTABLE` that must match a manifest exactly on `verify`.
 *
 * These are the corpus and its schema identity. The remaining tables are
 * append-only ledger rows that legitimately grow the moment any chat or smoke
 * run touches the store, so a snapshot taken before that traffic would
 * otherwise look corrupt.
 */
const CORPUS_TABLES = ["doc_parents", "doc_children", "aligned_pairs", "schema_migrations"];

/**
 * The subset of `SNAPSHOTABLE` that carries personal data (ADR-0043 decision 5).
 *
 * Named here so the CLI can say — in the manifest and in the create banner —
 * whether an archive carries personal data, rather than leaving a reader to
 * infer it from the table list. A whole-database `pg_dump` includes these
 * tables whether or not anyone thinks about them, which is the exposure
 * ADR-0043 decision 5 requires be written down.
 */
const PERSONAL_DATA_TABLES = [
  "users",
  "sessions",
  "chat_sessions",
  "chat_messages",
  "answer_traces",
  "eval_runs",
  "eval_results",
];

/** Whether a table's row count is part of the corpus identity. */
export const isCorpusTable = (name) => CORPUS_TABLES.includes(name);

/** Whether the table holds personal data, and therefore makes an archive one. */
export const isPersonalDataTable = (name) => PERSONAL_DATA_TABLES.includes(name);

/**
 * True when the given row counts describe an archive that carries personal
 * data: any personal-data table with at least one row. A schema-only snapshot
 * of an empty database is not a personal-data-bearing archive, and treating it
 * as one would forbid the one case where an unencrypted archive is honest.
 */
export function carriesPersonalData(counts) {
  return Object.entries(counts).some(([table, n]) => isPersonalDataTable(table) && Number(n) > 0);
}

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
