#!/usr/bin/env bun
/**
 * kajianq-restore.mjs — restore an encrypted backup into a SCRATCH database
 * and re-apply erasure (ADR-0043 decision 4, issue #180).
 *
 *   kajianq-restore.mjs --label <label> --target-url <scratch-postgres-url>
 *                       [--env-file /etc/kajianq/backup.env] [--keep]
 *
 * This is the documented restore procedure, as a script rather than folklore.
 * It is deliberately NOT able to write to the live database:
 *
 *   - `--target-url` is required and must not equal PGDATABASE_URL; the archive
 *     is restored into a scratch cluster (a separate Postgres, or a fresh
 *     database on the same server), never over the store that is serving.
 *   - The dump is decrypted by restic (the key is the repo key, outside the
 *     repo), re-hashed, and compared to the manifest before anything is
 *     restored — a corrupted archive stops here instead of producing a
 *     half-restored scratch database.
 *   - After the restore it re-runs the reclamation and erasure path for the
 *     affected window (`RECLAIM_SQL`, then `--erase-user` when given), because
 *     otherwise a restored row would silently resurrect data the live store had
 *     already deleted (ADR-0043 decision 4).
 *
 * The real-VPS run is the owner's (see docs/VPS-HARDENING-RUNBOOK.md), and the
 * same code path is exercised in CI by provision/vps/backup/restore-drill.mjs
 * against a scratch cluster.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  RECLAIM_SQL,
  REQUIRED_ENV,
  assertManifest,
  erasureSql,
  formatCounts,
  missingEnv,
  parseEnvFile,
  readLabel,
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
  return run("psql", ["-At", "-v", "ON_ERROR_STOP=1", ...extra, "-c", statement], {
    env: { ...process.env, ...pgEnv(url) },
  });
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

async function main() {
  const argv = process.argv.slice(2);
  const envFile = argAfter(argv, "--env-file");
  if (envFile) {
    const parsed = parseEnvFile(readFileSync(envFile, "utf8"));
    for (const [k, v] of Object.entries(parsed)) if (!process.env[k]) process.env[k] = v;
  }
  const missing = missingEnv(process.env).filter((k) => k !== "PGDATABASE_URL");
  if (missing.length > 0) fail(`missing configuration: ${missing.join(", ")} (set in --env-file)`);

  const label = readLabel(argAfter(argv, "--label"));
  const targetUrl = argAfter(argv, "--target-url");
  if (!targetUrl)
    fail("--target-url is required — a restore never targets the live URL implicitly");
  if (process.env.PGDATABASE_URL && targetUrl === process.env.PGDATABASE_URL) {
    fail(
      "--target-url equals PGDATABASE_URL — refusing. Restore into a scratch location; " +
        "restoring over the live store would resurrect erased data (ADR-0043 decision 4).",
    );
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
    // 1. Decrypt out of restic into the private temp dir.
    run("restic", [
      "-r",
      process.env.RESTIC_REPOSITORY,
      "restore",
      "latest",
      "--tag",
      `label:${label}`,
      "--target",
      tmp,
    ]);

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
    //    re-runnable; it only ever touches --target-url.
    run(
      "pg_restore",
      ["--clean", "--if-exists", "--no-owner", "--no-privileges", "-d", targetUrl, dumpPath],
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
      if (eraseUser) psql(targetUrl, erasureSql(eraseUser));
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
