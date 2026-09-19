#!/usr/bin/env bun
/**
 * kajianq-backup.mjs — encrypted, rolling backups of the personal-data-bearing
 * Postgres store (ADR-0043 decision 4, issue #180).
 *
 *   kajianq-backup.mjs [--env-file /etc/kajianq/backup.env] [--label <label>]
 *                      [--keep-daily 30] [--dry-run]
 *
 * What it does, in order:
 *   1. `pg_dump --format=custom` of the whole database into a private temp dir.
 *   2. Record a manifest — dump size, sha256, per-table row counts, and the
 *      source host/database NAME only (never credentials).
 *   3. `restic backup` the dump + manifest into the repository. restic encrypts
 *      client-side with the repository key, so the bytes at the target are
 *      encrypted at rest; the key lives in a root-only file outside the repo.
 *   4. `restic forget --keep-daily 30 --prune` — the 30-day rolling window.
 *      This is the only deletion path: a snapshot is never overwritten in
 *      place, it is superseded and then pruned (the immutable-label rule,
 *      ADR-0038 semantics).
 *
 * Credentials travel through the environment, never argv: `--env-file` is
 * parsed by this script and merged into `process.env`, so a password is never
 * in the process table and never in the shell history.
 *
 * The target is never a free tier (ADR-0043 register rule): the repository is
 * the owner's encrypted storage endpoint, configured in backup.env.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  BACKUP_KEEP_DAILY,
  buildManifest,
  formatCounts,
  labelTag,
  missingEnv,
  parseEnvFile,
  readLabel,
  retentionArgs,
  sha256Hex,
} from "./lib.mjs";

function fail(msg) {
  console.error(`kajianq-backup: ${msg}`);
  process.exit(1);
}

/** Run a command, inheriting env; throw with stderr on a non-zero exit. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { env: process.env, encoding: "utf8", ...opts });
  if (res.error) fail(`${cmd} could not run: ${res.error.message}`);
  if (res.status !== 0) fail(`${cmd} exited ${res.status}: ${(res.stderr || "").trim()}`);
  return (res.stdout || "").trim();
}

function argAfter(flags, name) {
  const i = flags.indexOf(name);
  return i >= 0 ? flags[i + 1] : undefined;
}

/** Decompose a connection URL into libpq PG* env vars (never argv). */
function pgEnv(url) {
  const u = new URL(url);
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: (u.pathname || "").replace(/^\//, "") || "postgres",
    PGSSLMODE: u.searchParams.get("sslmode") ?? "prefer",
  };
}

/**
 * Put the connection's libpq parameters into process.env, so `pg_dump` and
 * `psql` inherit them. Credentials travel as env vars, never as argv — the
 * password would otherwise be visible in the process table.
 */
function adoptPgEnv(url) {
  for (const [k, v] of Object.entries(pgEnv(url))) process.env[k] = v;
}

/** A connection URL for libpq without the credentials (for the manifest). */
function sourceLabel(url) {
  const u = new URL(url);
  return { host: u.hostname, database: (u.pathname || "").replace(/^\//, "") || "(default)" };
}

/** Exact row counts for the tables the manifest records. */
function tableCounts() {
  const sql =
    "SELECT relname || '|' || (xpath('/row/c/text()', query_to_xml(" +
    "'SELECT count(*) AS c FROM ' || quote_ident(relname), false, true, '')))[1]::text " +
    "FROM pg_stat_user_tables ORDER BY relname";
  const out = run("psql", ["-At", "-v", "ON_ERROR_STOP=1", "-c", sql]);
  const counts = {};
  for (const line of out.split("\n")) {
    const [name, n] = line.split("|");
    if (name) counts[name] = Number(n);
  }
  return counts;
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

async function main() {
  const argv = process.argv.slice(2);
  const envFile = argAfter(argv, "--env-file");
  if (envFile) {
    const parsed = parseEnvFile(readFileSync(envFile, "utf8"));
    for (const [k, v] of Object.entries(parsed)) if (!process.env[k]) process.env[k] = v;
  }

  const missing = missingEnv(process.env);
  if (missing.length > 0) {
    fail(
      `missing configuration: ${missing.join(", ")} — set them in --env-file ` +
        `(default /etc/kajianq/backup.env) or the environment`,
    );
  }
  // The password file must exist and be readable only by its owner; a
  // world-readable repo key is the one failure that silently undoes the
  // encryption, so it is checked rather than assumed.
  const passFile = process.env.RESTIC_PASSWORD_FILE;
  try {
    const mode = statSync(passFile).mode & 0o777;
    if (mode & 0o077) {
      fail(
        `RESTIC_PASSWORD_FILE ${passFile} is mode ${mode.toString(8)} — must not be ` +
          `group/world accessible (chmod 600)`,
      );
    }
  } catch (err) {
    fail(`RESTIC_PASSWORD_FILE ${passFile} is not readable: ${err.message}`);
  }

  const dryRun = argv.includes("--dry-run");
  const keepDaily = Number(argAfter(argv, "--keep-daily") ?? BACKUP_KEEP_DAILY);
  const label =
    argAfter(argv, "--label") ??
    `daily-${new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z")}`;
  readLabel(label);

  const url = process.env.PGDATABASE_URL;
  adoptPgEnv(url);
  const tmp = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "kajianq-backup-"));
  const dumpPath = join(tmp, `kajianq-${label}.dump`);
  const manifestPath = join(tmp, `kajianq-${label}.manifest.json`);

  try {
    // 1. Dump. `--no-owner --no-privileges` keeps the archive restorable into a
    //    scratch database under a different role.
    run("pg_dump", [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--compress=6",
      "--file",
      dumpPath,
    ]);

    // 2. Manifest. The bytes are hashed here; the restore side re-hashes what
    //    it decrypts, so a corrupted archive cannot pass as a good one.
    const bytes = readFileSync(dumpPath);
    const manifest = buildManifest({
      label,
      bytes: bytes.length,
      sha256: await sha256Hex(bytes),
      counts: tableCounts(),
      source: {
        ...sourceLabel(url),
        serverVersion: run("psql", ["-At", "-c", "SHOW server_version"]),
      },
      tool: {
        pgDump: run("pg_dump", ["--version"]),
        generator: "provision/vps/backup/kajianq-backup.mjs",
      },
      git: gitInfo(),
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    if (dryRun) {
      console.log(
        [
          `kajianq-backup: dry run — nothing uploaded`,
          `  dump      ${manifest.dump.bytes} bytes sha256 ${manifest.dump.sha256.slice(0, 16)}…`,
          `  source    ${manifest.source.host}/${manifest.source.database} (pg ${manifest.source.serverVersion})`,
          `  rows      ${formatCounts(manifest.tableCounts)}`,
        ].join("\n"),
      );
      return;
    }

    // 3. Encrypted upload. restic encrypts client-side with the repository key
    //    held outside the repo; the target therefore stores ciphertext only.
    run("restic", [
      "-r",
      process.env.RESTIC_REPOSITORY,
      "backup",
      "--tag",
      labelTag(label),
      dumpPath,
      manifestPath,
    ]);

    // 4. Rolling retention — the only deletion path.
    run("restic", ["-r", process.env.RESTIC_REPOSITORY, ...retentionArgs(keepDaily)]);

    console.log(
      [
        `kajianq-backup: created "${label}"`,
        `  dump      ${manifest.dump.bytes} bytes, sha256 ${manifest.dump.sha256.slice(0, 16)}…`,
        `  manifest  kajianq-${label}.manifest.json`,
        `  source    ${manifest.source.host}/${manifest.source.database} (pg ${manifest.source.serverVersion})`,
        `  rows      ${formatCounts(manifest.tableCounts)}`,
        `  retention one snapshot per day, ${keepDaily} days rolling (restic forget --prune)`,
        `  restore   provision/vps/backup/kajianq-restore.mjs --label ${label} --target-url <scratch>`,
      ].join("\n"),
    );
  } finally {
    // The plaintext dump must not outlive this process.
    rmSync(tmp, { recursive: true, force: true });
  }
}

await main();
