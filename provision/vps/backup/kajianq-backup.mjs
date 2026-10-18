#!/usr/bin/env bun
/**
 * kajianq-backup.mjs — encrypted, rolling backups of the personal-data-bearing
 * Postgres store (ADR-0043 decision 4).
 *
 *   kajianq-backup.mjs [--env-file /etc/kajianq/backup.env] [--label <label>]
 *                      [--keep-daily 30] [--dry-run] [--record <path>]
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
 *   5. Record the run's outcome — exit status, completion time, label and the
 *      revision it ran from — where the deploy's provenance preflight can read
 *      it. The record is the proof, not systemd's run fields: those describe
 *      the current boot and a reboot clears them.
 *
 * Credentials travel through the environment, never argv: `--env-file` is
 * parsed by this script and merged into `process.env`, so a password is never
 * in the process table and never in the shell history.
 *
 * The target is never a free tier (ADR-0043 register rule): the repository is
 * the owner's encrypted storage endpoint, configured in backup.env.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  BACKUP_KEEP_DAILY,
  applyEnvFile,
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

/**
 * Best-effort probe that NEVER aborts the run.
 *
 * `run()` fails through this script's `fail()`, which calls `process.exit(1)` —
 * an exit is not an exception, so no `try/catch` around a `run()` call can
 * recover from it. Provenance is therefore probed this way, never through
 * `run()`: a missing commit is not worth aborting a backup over.
 */
function probe(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { env: process.env, encoding: "utf8", ...opts });
  if (res.error || res.status !== 0) return undefined;
  return (res.stdout || "").trim();
}

function argAfter(flags, name) {
  const i = flags.indexOf(name);
  return i >= 0 ? flags[i + 1] : undefined;
}

/**
 * Where a completed run records its outcome for
 * provision/vps/deploy/backup-provenance.sh.
 *
 * Deliberately under /var/lib, not the deploy root: /srv/kajianq belongs to the
 * deploy identity, so a root-owned file there could still be renamed away by
 * the very identity the proof is meant to bind, and anything inside api/ or
 * web/ would be deleted by the next rsync. This directory is root-owned and
 * world-traversable, and the record is root-owned and world-readable: the
 * deploy identity can read a proof it cannot forge, and root can replace it.
 */
const DEFAULT_RECORD = "/var/lib/kajianq/backup-provenance";

// Filled in by main() once the flags and identity are known; the exit handler
// reads them when the process ends.
let recordPath = DEFAULT_RECORD;
let recordLabel = "unknown";
let recordRevision = "unknown";
let recordEnabled = true;

/**
 * Write the run's outcome for the deploy's provenance preflight. Temp file plus
 * rename, so a reader never sees a half-written record.
 *
 * Never throws: a failed write must not turn a backup that succeeded into a
 * failed run, and this runs from the process's exit handler.
 */
function writeRecord(status) {
  const dir = dirname(recordPath);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  const body = [
    `status=${status}`,
    `completed_at=${Math.floor(Date.now() / 1000)}`,
    `label=${recordLabel}`,
    `revision=${recordRevision}`,
    "",
  ].join("\n");
  const tmp = join(dir, `.${basename(recordPath)}.${process.pid}.tmp`);
  writeFileSync(tmp, body, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, recordPath);
}

process.on("exit", (code) => {
  // A dry run uploads nothing and must not overwrite the last real run's proof.
  if (!recordEnabled) return;
  try {
    writeRecord(code ?? 1);
  } catch (err) {
    console.error(
      `kajianq-backup: could not write the provenance record at ${recordPath}: ${err.message}`,
    );
  }
});

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

/**
 * The deployed revision, for the manifest's provenance field.
 *
 * Best-effort by design: a backup's integrity does not depend on knowing which
 * commit produced it, so nothing here may abort the run.
 *
 * `cwd` is pointed at the script's own directory rather than inherited: the
 * unit's `WorkingDirectory` is the deployed tree, which is not a repository, so
 * an inherited cwd would always miss even where a checkout exists alongside.
 */
function gitInfo() {
  const cwd = dirname(fileURLToPath(import.meta.url));
  return {
    sha: probe("git", ["rev-parse", "HEAD"], { cwd }) ?? "unknown",
    branch: probe("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }) ?? "unknown",
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const recordArg = argAfter(argv, "--record");
  if (recordArg) recordPath = recordArg;
  // A record is proof about the UNIT, so only the unit's own run may leave one:
  // systemd sets INVOCATION_ID for it. A checkout invocation records only when
  // --record explicitly names a path (tests, the restore drill), because it does
  // not prove the unit's ExecStart or environment. A dry run records nothing
  // either way: it uploads nothing and must not overwrite the last real run.
  recordEnabled = !dryRun && (Boolean(recordArg) || process.env.INVOCATION_ID !== undefined);

  const keepDaily = Number(argAfter(argv, "--keep-daily") ?? BACKUP_KEEP_DAILY);
  const label =
    argAfter(argv, "--label") ??
    `daily-${new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z")
      .toLowerCase()}`;
  readLabel(label);
  // The record's identity and the manifest's provenance are the same probe; it
  // is best-effort and is taken before a failure can end the run, so a failed
  // run's record still says which revision and label it failed on.
  const git = gitInfo();
  recordLabel = label;
  recordRevision = git.sha;

  const envFile = argAfter(argv, "--env-file");
  if (envFile) applyEnvFile(process.env, parseEnvFile(readFileSync(envFile, "utf8")));

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
      git,
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
    //    The repository comes from RESTIC_REPOSITORY in the environment, never
    //    argv: a repository URL that embeds storage credentials (s3://,
    //    sftp://) would otherwise be readable in the process table.
    run("restic", ["backup", "--tag", labelTag(label), dumpPath, manifestPath]);

    // 4. Rolling retention — the only deletion path.
    run("restic", retentionArgs(keepDaily));

    console.log(
      [
        `kajianq-backup: created "${label}"`,
        `  dump      ${manifest.dump.bytes} bytes, sha256 ${manifest.dump.sha256.slice(0, 16)}…`,
        `  manifest  kajianq-${label}.manifest.json`,
        `  source    ${manifest.source.host}/${manifest.source.database} (pg ${manifest.source.serverVersion})`,
        `  rows      ${formatCounts(manifest.tableCounts)}`,
        `  retention one snapshot per day, ${keepDaily} days rolling (restic forget --prune)`,
        `  restore   provision/vps/backup/kajianq-restore.mjs --label ${label} --env-file /etc/kajianq/backup.env`,
      ].join("\n"),
    );
  } finally {
    // The plaintext dump must not outlive this process.
    rmSync(tmp, { recursive: true, force: true });
  }
}

await main();
