#!/usr/bin/env bun
/**
 * pg-search-probe.mjs — probe BM25/pg_search availability on the Postgres
 * server the store runs on (#4 AC: "pg_search/BM25 availability on the
 * plan probed and result recorded (fallback: tsvector)").
 *
 *   DATABASE_URL=postgres://… bun packages/infra/scripts/pg-search-probe.mjs
 *
 * Prints a small JSON report to stdout. Paste the output into the #4 PR (or
 * an ADR if the result is surprising) — recording the result is part of the
 * acceptance criterion, not just running the probe.
 *
 * What it checks, in order:
 *   1. pgvector availability — required by the whole retrieval posture.
 *   2. `pg_search` extension (the BM25 index from ParadeDB) as an installable
 *      extension on this server.
 *   3. Built-in full-text search (tsvector) as the designed-in fallback.
 *
 * The probe never creates or drops any extension — `SELECT … FROM
 * pg_available_extensions` reads the catalog the server exposes, which is the
 * documented way to see what it offers without mutating it.
 */
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("pg-search-probe: DATABASE_URL is not set");
  process.exit(1);
}
const pool = new Pool({ connectionString: url });

async function availableExtensions() {
  const { rows } = await pool.query(`
    SELECT name, default_version, installed_version
    FROM pg_available_extensions
    ORDER BY name
  `);
  return rows;
}

async function hasTsvectorConfigs() {
  const { rows } = await pool.query(`
    SELECT cfgname FROM pg_catalog.pg_ts_config
    WHERE cfgname IN ('arabic', 'indonesian', 'english', 'simple')
    ORDER BY cfgname
  `);
  return rows.map((r) => r.cfgname);
}

const extensions = await availableExtensions();
const byName = Object.fromEntries(extensions.map((e) => [e.name, e]));

const report = {
  probedAt: new Date().toISOString(),
  pgvector: byName["vector"]
    ? {
        available: true,
        defaultVersion: byName["vector"].default_version,
        installed: byName["vector"].installed_version,
      }
    : { available: false },
  pg_search: byName["pg_search"]
    ? {
        available: true,
        defaultVersion: byName["pg_search"].default_version,
        installed: byName["pg_search"].installed_version,
      }
    : { available: false, note: "not in pg_available_extensions on this server" },
  tsvectorConfigs: await hasTsvectorConfigs(),
  verdict: byName["pg_search"]
    ? "pg_search is installable; BM25 via ParadeDB is an option. See spec §161."
    : "pg_search not offered on this server — the designed-in tsvector fallback " +
      "(doc_children_text_id_tsvector, spec §161) is the sparse channel. " +
      "No action required; this is the expected low-cost baseline.",
};

console.log(JSON.stringify(report, null, 2));
await pool.end();
