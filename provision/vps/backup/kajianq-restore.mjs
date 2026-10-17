#!/usr/bin/env bun
/**
 * kajianq-restore.mjs — restore an encrypted backup into a SCRATCH database
 * and re-apply erasure (ADR-0043 decision 4).
 *
 *   kajianq-restore.mjs --label <label> --env-file /etc/kajianq/backup.env
 *                       [--target-url <scratch-postgres-url>] [--keep]
 *
 * The scratch target is `RESTORE_TARGET_URL` in the environment; the documented
 * invocation reads it from the root-owned env file (`--env-file`), so the
 * operator's command line carries a label and a path, and no credential ever
 * reaches `ps` or the shell history. An explicitly passed `--target-url` still
 * works for compatibility, and wins when both are given.
 *
 * This is the documented restore procedure, as a script rather than folklore.
 * It is deliberately NOT able to write to the live database:
 *
 *   - The scratch target (`RESTORE_TARGET_URL`, or `--target-url` when passed)
 *     and PGDATABASE_URL are both required, and the target must not name the
 *     same database as PGDATABASE_URL (compared by normalized location — host,
 *     port, database name — not raw string; a missing PGDATABASE_URL fails
 *     closed rather than skipping the comparison); the archive is restored into
 *     a scratch cluster (a separate Postgres, or a fresh database on the same
 *     server), never over the store that is serving. Credentials stay off argv
 *     on every hop: the operator's invocation passes no URL, pg_restore gets
 *     the database name only, and it and psql read the rest from the PG*
 *     environment.
 *   - The dump is decrypted by restic (the key is the repo key, outside the
 *     repo), re-hashed, and compared to the manifest before anything is
 *     restored — a corrupted archive stops here instead of producing a
 *     half-restored scratch database.
 *   - After the restore it re-runs the reclamation and erasure path for the
 *     affected window (`RECLAIM_SQL`, then `--erase-user` when given), because
 *     otherwise a restored row would silently resurrect data the live store had
 *     already deleted (ADR-0043 decision 4).
 *
 * The real-VPS run is the operator's (see docs/VPS-SETUP.md), and the
 * same code path is exercised in CI by provision/vps/backup/restore-drill.mjs
 * against a scratch cluster: its first pass uses the compatibility
 * `--target-url` and its second the documented `--env-file`, so the
 * env-provided target is covered end to end. The drill's own `--admin-url`
 * carries a throwaway service-container credential created and dropped per run
 * — not an operator credential, and deliberately not moved into the
 * environment.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  RECLAIM_SQL,
  applyEnvFile,
  assertManifest,
  dbLocation,
  erasurePsqlArgs,
  erasureSql,
  formatCounts,
  missingEnv,
  parseEnvFile,
  readLabel,
  resolveScratchTarget,
  sha256Hex,
  verifyRestore,
} from "./lib.mjs";

function fail(msg) {
  console.error(`kajianq-restore: ${msg}`);
  process.exit(1);
}

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

function psql(url, statement, extra = []) {
  // The statement travels on stdin (`-f -`), never as the `-c` value: psql
  // only performs `:'var'` substitution for variables in script input, not in
  // `-c` command text, and stdin keeps every statement — including the Art. 17
  // one with its bound id — off the process table's argv.
  const res = spawnSync("psql", ["-At", "-v", "ON_ERROR_STOP=1", ...extra, "-f", "-"], {
    env: { ...process.env, ...pgEnv(url) },
    encoding: "utf8",
    input: statement,
  });
  if (res.error) fail(`psql could not run: ${res.error.message}`);
  if (res.status !== 0) fail(`psql exited ${res.status}: ${(res.stderr || "").trim()}`);
  return (res.stdout || "").trim();
}

function tableCounts(url) {
  const sql =
    "SELECT relname || '|' || (xpath('/row/c/text()', query_to_xml(" +
    "'SELECT count(*) AS c FROM ' || quote_ident(relname), false, true, '')))[1]::text " +
    "FROM pg_stat_user_tables ORDER BY relname";
  const counts = {};
  for (const line of psql(url, sql).split("\n")) {
    const [name, n] = line.split("|");
    if (name) counts[name] = Number(n);
  }
  return counts;
}

// The Art. 17 statement is fixed text with the user id bound as a psql
// variable (see lib.mjs) — the id never becomes part of the statement.
const ERASE_SQL = erasureSql();

async function main() {
  const argv = process.argv.slice(2);
  const envFile = argAfter(argv, "--env-file");
  if (envFile) applyEnvFile(process.env, parseEnvFile(readFileSync(envFile, "utf8")));
  const missing = missingEnv(process.env).filter((k) => k !== "PGDATABASE_URL");
  if (missing.length > 0) fail(`missing configuration: ${missing.join(", ")} (set in --env-file)`);

  const label = readLabel(argAfter(argv, "--label"));
  // The scratch target comes from the environment; an explicit --target-url
  // wins over it. Both forms go through the same live-URL refusal inside
  // resolveScratchTarget — an env-provided target must not skip the guard.
  let targetUrl;
  try {
    targetUrl = resolveScratchTarget({
      flagTarget: argAfter(argv, "--target-url"),
      env: process.env,
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const eraseUser = argAfter(argv, "--erase-user");
  const keep = argv.includes("--keep");
  // Drill-only: stop after verification, without re-applying erasure. The
  // restore drill uses it to observe the resurrected rows first (its negative
  // control — without that observation the drill could pass while testing
  // nothing), then runs this same script again in its default mode to exercise
  // the production erasure step. It is deliberately not the default: on the
  // real host, a restore that skipped erasure would leave deleted data alive.
  const skipErasure = argv.includes("--skip-erasure");

  const tmp = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "kajianq-restore-"));
  try {
    // 1. Decrypt out of restic into the private temp dir. The repository comes
    //    from RESTIC_REPOSITORY in the environment, never argv.
    run("restic", ["restore", "latest", "--tag", `label:${label}`, "--target", tmp]);

    // 2. Read + validate the manifest and re-hash the decrypted dump. The
    //    hash is the integrity check the manifest exists for; without it the
    //    restore could silently land a truncated archive.
    const dumpPath = findInTmp(tmp, `kajianq-${label}.dump`);
    const manifestPath = findInTmp(tmp, `kajianq-${label}.manifest.json`);
    const manifest = assertManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    const bytes = readFileSync(dumpPath);
    const sha256 = await sha256Hex(bytes);
    if (bytes.length !== manifest.dump.bytes) {
      fail(`dump size mismatch: manifest ${manifest.dump.bytes}, restored ${bytes.length}`);
    }
    if (sha256 !== manifest.dump.sha256) {
      fail(`dump sha256 mismatch: manifest ${manifest.dump.sha256}, restored ${sha256}`);
    }

    // 3. Restore into the scratch target. --clean --if-exists makes the drill
    //    re-runnable; it only ever touches the resolved scratch target. The
    //    database name alone goes to -d: the rest of the connection travels as
    //    libpq env vars (below), so the password is never on the command line
    //    where `ps` would expose it.
    run(
      "pg_restore",
      [
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "-d",
        dbLocation(targetUrl).database,
        dumpPath,
      ],
      { env: { ...process.env, ...pgEnv(targetUrl) } },
    );

    // 4. Verify the restore against the manifest BEFORE re-applying erasure:
    //    at this point the scratch database must equal the archive exactly, so
    //    any difference means the restore is not faithful.
    const counts = tableCounts(targetUrl);
    const verdict = verifyRestore(manifest, { bytes: bytes.length, sha256, counts });
    if (!verdict.ok) {
      fail(
        [
          `restore of "${label}" does not match its manifest:`,
          ...verdict.reasons.map((r) => `  ${r}`),
        ].join("\n"),
      );
    }

    // 5. Re-apply erasure for the affected window (ADR-0043 decision 4). The
    //    reclamation statements are `cleanupExpiredSessions` verbatim; an
    //    explicit `--erase-user` re-runs the Art. 17 cascade for a request that
    //    arrived after the backup.
    if (!skipErasure) {
      for (const statement of RECLAIM_SQL) psql(targetUrl, statement);
      if (eraseUser) psql(targetUrl, ERASE_SQL, erasurePsqlArgs(eraseUser));
    }

    console.log(
      [
        `kajianq-restore: "${label}" restored into the scratch target`,
        `  sha256    ${sha256.slice(0, 16)}… matches the manifest`,
        `  rows      ${formatCounts(counts)} (archive, before erasure)`,
        `  verified  every table matches the manifest`,
        skipErasure
          ? `  erasure   SKIPPED (--skip-erasure) — the restored archive is left as-is`
          : `  erasure   reclamation re-applied${eraseUser ? `; Art. 17 erase for ${eraseUser}` : ""}`,
      ].join("\n"),
    );
  } finally {
    if (!keep) rmSync(tmp, { recursive: true, force: true });
  }
}

/** restic preserves the source path, so the dump lands under a nested dir. */
function findInTmp(root, basename) {
  const res = spawnSync("find", [root, "-name", basename, "-type", "f"], { encoding: "utf8" });
  const path = (res.stdout || "").trim().split("\n").filter(Boolean)[0];
  if (!path) fail(`restored archive is missing ${basename} — the snapshot is incomplete`);
  return path;
}

await main();
