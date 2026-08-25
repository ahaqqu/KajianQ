#!/usr/bin/env bun
/**
 * db-migrate.mjs — KajianQ migration CLI (#4).
 *
 *   NEON_DATABASE_URL=postgres://… bun packages/infra/scripts/db-migrate.mjs status
 *   NEON_DATABASE_URL=postgres://… bun packages/infra/scripts/db-migrate.mjs up
 *   NEON_DATABASE_URL=postgres://… bun packages/infra/scripts/db-migrate.mjs up --step 1
 *   NEON_DATABASE_URL=postgres://… bun packages/infra/scripts/db-migrate.mjs down
 *   NEON_DATABASE_URL=postgres://… bun packages/infra/scripts/db-migrate.mjs down --step 2
 *
 * Multiple migration sets share one Neon database and one ledger. Pass
 * `--dir <path>` (relative to cwd) to target a set:
 *
 *   bun run db:up                                 # engine (packages/infra)
 *   bun run db:up:domain                          # domain (kajianq-domain)
 *   bun run db:up:api                              # product (apps/api)
 *
 * Conventions:
 *   - Migration files live in a migrations dir as NNNN_name.sql, with a
 *     required NNNN_name.down.sql companion for rollback.
 *   - `up` applies pending migrations in filename order; `down` rolls back
 *     the most recent `step` migrations (default 1) via their `.down.sql`.
 *   - Applied migrations are recorded in the shared `schema_migrations(name)`
 *     ledger; migration *names* must be unique across all dirs.
 *
 * Runs over Neon's WebSocket `Pool` (not the HTTP `neon()` function) because
 * migrations need session transactions: each file is applied as an explicit
 * `BEGIN … COMMIT` so a failed statement rolls the whole migration back, and
 * the ledger row is inserted inside that same transaction. The runtime
 * RagStore adapter stays on the HTTP `neon()` function — only the migration
 * CLI uses `Pool`.
 */
import { Pool } from "@neondatabase/serverless";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

// Active migrations directory; overridden by `--dir`. One shared ledger
// (schema_migrations) covers all dirs — migration *names* are unique across
// dirs (engine: 0001_init, domain: 0001_concept_graph, app: 0001_product).
let MIGRATIONS_DIR = DEFAULT_MIGRATIONS_DIR;

function fail(msg) {
  console.error(`db-migrate: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { command: argv[2] ?? "status", step: null, dir: null };
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === "--step") {
      args.step = Number.parseInt(argv[i + 1] ?? "", 10);
      i += 1;
    } else if (argv[i] === "--dir") {
      args.dir = argv[i + 1] ?? fail("--dir requires a path argument");
      i += 1;
    } else {
      fail(`unknown argument: ${argv[i]}`);
    }
  }
  if (args.step !== null && (!Number.isInteger(args.step) || args.step < 1)) {
    fail("--step must be a positive integer");
  }
  return args;
}

/** Names of up-migration files in order, e.g. ["0001_init.sql", ...]. */
async function listMigrations() {
  const files = await readdir(MIGRATIONS_DIR);
  return files
    .filter((f) => /^\d+_.+\.sql$/.test(f) && !f.endsWith(".down.sql"))
    .sort();
}

/** Strip the file's own BEGIN/COMMIT wrapper — the runner owns the transaction. */
function stripTxnMarkers(sql) {
  return sql
    .split("\n")
    .filter((l) => !/^\s*(BEGIN|COMMIT)\s*;?\s*$/i.test(l))
    .join("\n");
}

async function ensureLedger(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name        text PRIMARY KEY,
       applied_at  timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

async function appliedNames(client) {
  await ensureLedger(client);
  const { rows } = await client.query(
    `SELECT name FROM schema_migrations ORDER BY name`,
  );
  return new Set(rows.map((r) => r.name));
}

/**
 * Run one migration file + its ledger row in a single transaction. The file's
 * own BEGIN/COMMIT markers are stripped first, so the runner can own the
 * transaction and roll the ledger write back with the DDL if anything fails.
 */
async function applyFile(client, file, ledgerSql, ledgerParams) {
  const text = await readFile(join(MIGRATIONS_DIR, file), "utf8");
  const body = stripTxnMarkers(text);
  await client.query("BEGIN");
  try {
    await client.query(body);
    await client.query(ledgerSql, ledgerParams);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

async function up(client, step) {
  const all = await listMigrations();
  const applied = await appliedNames(client);
  const pending = all.filter((f) => !applied.has(f));
  const todo = step === null ? pending : pending.slice(0, step);
  if (todo.length === 0) {
    console.log("up: nothing to apply");
    return;
  }
  for (const file of todo) {
    console.log(`up: applying ${file} …`);
    await applyFile(
      client,
      file,
      `INSERT INTO schema_migrations (name) VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [file],
    );
    console.log(`up: applied  ${file}`);
  }
}

async function down(client, step) {
  const applied = await appliedNames(client);
  const ordered = (await listMigrations()).filter((f) => applied.has(f));
  const n = step === null ? 1 : step;
  const todo = ordered.slice(-n);
  if (todo.length === 0) {
    console.log("down: nothing to roll back");
    return;
  }
  for (const file of todo.reverse()) {
    const downName = file.replace(/\.sql$/, ".down.sql");
    try {
      await readFile(join(MIGRATIONS_DIR, downName), "utf8");
    } catch {
      fail(`missing rollback file for ${file} (expected ${downName})`);
    }
    console.log(`down: rolling back ${file} …`);
    await applyFile(
      client,
      downName,
      `DELETE FROM schema_migrations WHERE name = $1`,
      [file],
    );
    console.log(`down: rolled back  ${file}`);
  }
}

async function status(client) {
  const all = await listMigrations();
  const applied = await appliedNames(client);
  for (const f of all) {
    console.log(`${applied.has(f) ? "applied  " : "pending  "} ${f}`);
  }
}

async function main() {
  const { command, step, dir } = parseArgs(process.argv);
  if (dir) MIGRATIONS_DIR = resolve(process.cwd(), dir);
  const url = process.env.NEON_DATABASE_URL;
  if (!url) fail("NEON_DATABASE_URL is not set");
  const pool = new Pool({ connectionString: url });
  pool.on("error", (err) => console.error("db-migrate: pool error", err));
  const client = await pool.connect();
  try {
    if (command === "up") await up(client, step);
    else if (command === "down") await down(client, step);
    else if (command === "status") await status(client);
    else fail(`unknown command: ${command} (expected up|down|status)`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(
    `db-migrate: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
