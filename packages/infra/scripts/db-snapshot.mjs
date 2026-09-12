#!/usr/bin/env bun
/**
 * db-snapshot.mjs — portable, restorable snapshots of the staged corpus (ADR-0038).
 * The corpus is a paid, non-trivially-reproducible asset: it must never live in
 * exactly one place, and no money-spending ingest may run without a verified
 * snapshot of the state it is about to change.
 *
 *   create <label> | verify <label> | require <label> | list | download | restore-plan
 *
 * Env: NEON_DATABASE_URL plus the R2_* credentials. The connection URL is
 * decomposed into libpq PG* env vars, never argv, and the manifest records host
 * and database name only — never credentials. This is the portable layer of the
 * two-layer guardrail (survives project deletion, plan downgrade, or a v2
 * re-embed); the provider (Neon) snapshot is the fast in-place layer taken
 * alongside it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCorpusTable, pgEnv, run, sql, tableCounts } from "./pg-conn.mjs";
import {
  createSnapshotStore,
  dumpKey,
  getObject,
  listObjects,
  manifestKey,
  putObject,
  sha256Hex,
} from "./snapshot-store.mjs";

const TMP = process.env.TMPDIR ?? "/tmp";
const LABEL_RE = /^[a-z0-9][a-z0-9-]{2,60}$/;

function fail(msg) {
  console.error(`db-snapshot: ${msg}`);
  process.exit(1);
}

function gitInfo() {
  try {
    return {
      sha: run("git", ["rev-parse", "HEAD"]),
      branch: run("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    };
  } catch {
    return { sha: "unknown", branch: "unknown" };
  }
}

function sourceLabel(neonUrl) {
  const u = new URL(neonUrl);
  return { host: u.hostname, database: u.pathname.replace(/^\//, "") || "(default)" };
}

function argAfter(flags, name) {
  const i = flags.indexOf(name);
  return i >= 0 ? flags[i + 1] : undefined;
}

function readLabel(argv) {
  const label = argv[0];
  if (!label) fail("a snapshot label is required (e.g. pre-ingest-20260912T1200Z)");
  if (!LABEL_RE.test(label)) {
    fail(`label "${label}" must match ${LABEL_RE} — lowercase, digits and dashes only`);
  }
  return label;
}

async function cmdCreate(label) {
  const neonUrl = process.env.NEON_DATABASE_URL;
  if (!neonUrl) fail("NEON_DATABASE_URL is not set — nothing to snapshot");
  const { store, bucket } = createSnapshotStore();

  if (await getObject(store, manifestKey(label))) {
    fail(
      `snapshot "${label}" already exists in ${bucket} — refusing to overwrite. ` +
        `Take a new label instead (a snapshot is only ever superseded, never replaced).`,
    );
  }

  const pgDumpVersion = run("pg_dump", ["--version"]);
  const dir = mkdtempSync(join(TMP, "kajianq-snapshot-"));
  const dumpPath = join(dir, `kajianq-${label}.dump`);
  try {
    run(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-privileges", "--compress=6", "--file", dumpPath],
      pgEnv(neonUrl),
    );
    const bytes = readFileSync(dumpPath);
    const manifest = {
      label,
      createdAt: new Date().toISOString(),
      tool: { pgDump: pgDumpVersion, generator: "packages/infra/scripts/db-snapshot.mjs" },
      git: gitInfo(),
      source: {
        ...sourceLabel(neonUrl),
        serverVersion: sql(neonUrl, "SHOW server_version"),
        databaseBytes: Number(sql(neonUrl, "SELECT pg_database_size(current_database())")),
        migrations: sql(
          neonUrl,
          "SELECT coalesce(string_agg(name, ',' ORDER BY name), '') FROM schema_migrations",
        ),
      },
      dump: { key: dumpKey(label), bytes: bytes.length, sha256: sha256Hex(bytes) },
      tableCounts: tableCounts(neonUrl),
    };
    await putObject(store, dumpKey(label), bytes);
    await putObject(store, manifestKey(label), JSON.stringify(manifest, null, 2));
    console.log(
      [
        `db-snapshot: created "${label}" in ${bucket}`,
        `  dump      ${dumpKey(label)} (${(bytes.length / 1024 / 1024).toFixed(1)} MB, sha256 ${manifest.dump.sha256.slice(0, 16)}…)`,
        `  manifest  ${manifestKey(label)}`,
        `  source    ${manifest.source.host}/${manifest.source.database} @ ${manifest.git.sha.slice(0, 8)} (pg ${manifest.source.serverVersion})`,
        `  rows      ${Object.entries(manifest.tableCounts)
          .map(([t, n]) => `${t}=${n}`)
          .join(" ")}`,
      ].join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function loadManifest(store, label) {
  const raw = await getObject(store, manifestKey(label));
  if (!raw) fail(`snapshot "${label}" has no manifest — it does not exist in this bucket`);
  return JSON.parse(new TextDecoder().decode(raw));
}

async function cmdRequire(label) {
  const { store, bucket } = createSnapshotStore();
  const manifest = await loadManifest(store, label);
  const keys = await listObjects(store, `snapshots/${label}/`);
  if (!keys.includes(manifest.dump.key)) {
    fail(`snapshot "${label}" has a manifest but no dump object at ${manifest.dump.key}`);
  }
  console.log(
    `db-snapshot: requirement satisfied — "${label}" present in ${bucket} ` +
      `(${(manifest.dump.bytes / 1024 / 1024).toFixed(1)} MB, created ${manifest.createdAt})`,
  );
}

async function cmdVerify(label) {
  const { store } = createSnapshotStore();
  const manifest = await loadManifest(store, label);
  const dump = await getObject(store, manifest.dump.key);
  if (!dump) fail(`dump object ${manifest.dump.key} is missing`);
  if (dump.length !== manifest.dump.bytes) {
    fail(`dump size mismatch: expected ${manifest.dump.bytes}, downloaded ${dump.length}`);
  }
  const actual = sha256Hex(dump);
  if (actual !== manifest.dump.sha256) {
    fail(`dump hash mismatch: manifest ${manifest.dump.sha256}, downloaded ${actual}`);
  }

  const neonUrl = process.env.NEON_DATABASE_URL;
  // Round-3 A5: the live counts are read up front and the headline reflects
  // the verdict — a drifted snapshot must not print a "verified" banner, and
  // the drift line must show what the live database actually holds next to
  // what the manifest recorded (a bare manifest count is not diagnosable).
  const live = neonUrl ? tableCounts(neonUrl) : null;
  let corpusDrift = [];
  let ledgerDrift = [];
  if (live) {
    const changed = Object.entries(manifest.tableCounts).filter(([t, n]) => live[t] !== n);
    // Only the corpus must match: the ledger tables are append-only and change
    // as soon as any chat or smoke run touches the store, so treating their
    // growth as corruption would flag every healthy snapshot. They are still
    // reported, so real data loss is visible rather than hidden.
    corpusDrift = changed.filter(([t]) => isCorpusTable(t));
    ledgerDrift = changed.filter(([t]) => !isCorpusTable(t));
  }
  const drifted = corpusDrift.length > 0;
  console.log(
    [
      `db-snapshot: "${label}" ${drifted ? "CORPUS DRIFT — NOT verified" : "verified"}`,
      `  sha256    ${actual.slice(0, 16)}… matches the manifest`,
      `  size      ${(dump.length / 1024 / 1024).toFixed(1)} MB`,
      live === null
        ? "  (NEON_DATABASE_URL unset — integrity checked, live counts skipped)"
        : drifted
          ? `  CORPUS DRIFT: ${corpusDrift.map(([t, n]) => `${t} manifest=${n} live=${live[t]}`).join(", ")}`
          : "  corpus row counts match the live database",
      ...(ledgerDrift.length > 0
        ? [
            `  ledger tables moved on (expected): ${ledgerDrift.map(([t, n]) => `${t} manifest=${n} live=${live[t]}`).join(", ")}`,
          ]
        : []),
    ].join("\n"),
  );
  if (drifted) process.exit(2);
}

async function cmdList() {
  const { store, bucket } = createSnapshotStore();
  const keys = await listObjects(store, "snapshots/");
  const labels = keys
    .filter((k) => k.endsWith("/manifest.json"))
    .map((k) => k.split("/")[1])
    .sort();
  if (labels.length === 0) {
    console.log(`db-snapshot: no snapshots in ${bucket} — the corpus has no portable backup`);
    return;
  }
  for (const label of labels) {
    const m = await loadManifest(store, label);
    const total = Object.values(m.tableCounts).reduce((a, b) => a + b, 0);
    console.log(
      `${label}  ${m.createdAt}  ${(m.dump.bytes / 1024 / 1024).toFixed(1)} MB  ` +
        `sha ${m.dump.sha256.slice(0, 12)}…  git ${(m.git?.sha ?? "?").slice(0, 8)}  rows ${total}`,
    );
  }
}

async function cmdDownload(label, out) {
  const { store } = createSnapshotStore();
  const manifest = await loadManifest(store, label);
  const dump = await getObject(store, manifest.dump.key);
  if (!dump) fail(`dump object ${manifest.dump.key} is missing`);
  const actual = sha256Hex(dump);
  if (actual !== manifest.dump.sha256) fail(`hash mismatch for "${label}" — refusing to write it`);
  const path = out ?? join(process.cwd(), `kajianq-${label}.dump`);
  writeFileSync(path, dump);
  console.log(
    `db-snapshot: wrote ${path} (${(dump.length / 1024 / 1024).toFixed(1)} MB, sha256 verified)`,
  );
  console.log(
    `  restore: pg_restore --clean --if-exists --no-owner --no-privileges -d <target> "${path}"`,
  );
}

function cmdRestorePlan(label, file) {
  const path = file ?? `<downloaded kajianq-${label}.dump>`;
  console.log(
    [
      `Restore plan for snapshot "${label}" (ADR-0038):`,
      `  1. bun run db:snapshot download ${label}`,
      `  2. pg_restore --clean --if-exists --no-owner --no-privileges -d "$TARGET_URL" "${path}"`,
      `  3. psql "$TARGET_URL" -At -c "SELECT count(*) FROM doc_children"`,
      `  4. bun run db:snapshot verify ${label}   # compares live rows to the manifest`,
      `Restore is manual by design: --clean drops objects in the target, so it never`,
      `defaults to a live database. Restore into a NEW branch or project, verify, then`,
      `repoint DATABASE_URL.`,
    ].join("\n"),
  );
}

const [command, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "create":
      await cmdCreate(readLabel(rest));
      break;
    case "verify":
      await cmdVerify(readLabel(rest));
      break;
    case "require":
      await cmdRequire(readLabel(rest));
      break;
    case "list":
      await cmdList();
      break;
    case "download":
      await cmdDownload(readLabel(rest), argAfter(rest, "--out"));
      break;
    case "restore-plan":
      cmdRestorePlan(readLabel(rest), argAfter(rest, "--file"));
      break;
    default:
      fail(
        `unknown command "${command ?? ""}" — expected one of: create, verify, require, list, download, restore-plan`,
      );
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
