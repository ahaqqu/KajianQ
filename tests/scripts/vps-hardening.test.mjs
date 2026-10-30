import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import {
  BACKUP_KEEP_DAILY,
  LABEL_RE,
  LOG_RETENTION_DAYS,
  RECLAIM_SQL,
  REQUIRED_ENV,
  applyEnvFile,
  assertManifest,
  buildManifest,
  dbLocation,
  erasurePsqlArgs,
  erasureSql,
  formatCounts,
  isSameDatabase,
  labelTag,
  missingEnv,
  parseEnvFile,
  readLabel,
  resolveScratchTarget,
  retentionArgs,
  sha256Hex,
  verifyRestore,
} from "../../provision/vps/backup/lib.mjs";
import { ensureRecordDir } from "../../provision/vps/backup/provenance.mjs";
import { statusLines } from "../../packages/infra/scripts/db-migrate.mjs";

/**
 * VPS privacy-hardening policy (the Art. 30 record §6; ADR-0043 decision 4
 * records the retention decisions behind those values).
 *
 * The backup/restore tooling is only as trustworthy as the decisions inside it: the
 * rolling window, the integrity check, and the erasure a restore must re-apply. Those
 * decisions are pure functions here so they can be asserted directly — the end-to-end
 * path against a real Postgres is `provision/vps/backup/restore-drill.mjs`.
 */

const MANIFEST = buildManifest({
  label: "daily-20260919t031500z",
  bytes: 4096,
  sha256: "a".repeat(64),
  counts: { users: 3, sessions: 3, chat_messages: 5, answer_traces: 5 },
  source: { host: "db.internal", database: "kajianq" },
  tool: { pgDump: "pg_dump (PostgreSQL) 18.6", generator: "test" },
});

/** A URL that embeds credentials — what must never appear in a command line we teach. */
const CREDENTIALED_URL = /postgres(ql)?:\/\/[^\s"']*:[^\s"'@]+@/;

/** A shell variable holding a connection URL — what a command we teach must never hand out. */
const URL_VARIABLE = /\$\{?[A-Za-z_][A-Za-z0-9_]*URL\}?/;

/** The executable lines of every bash block in a doc section, comments stripped. */
function bashLines(text) {
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .join("\n")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/**
 * A temporary PATH holding stub `restic`, `pg_restore` and `psql`, so a restore CLI
 * driven end to end gets past the guard without the real tools: restic materialises the
 * snapshot the script expects, pg_restore records the libpq connection it was handed
 * (argument and environment), and psql exits 0. The recorded connection is the resolved
 * target — the signal a run that only dies at a missing restic cannot give.
 */
function stubTools(label) {
  const dir = mkdtempSync(join(tmpdir(), "kajianq-stub-"));
  const marker = join(dir, "pg_restore.json");
  const manifest = buildManifest({
    label,
    bytes: 1,
    sha256: "0".repeat(64),
    counts: {},
    source: { host: "stub", database: "kajianq" },
    tool: { pgDump: "stub", generator: "test" },
  });
  const program = (name, source) => {
    writeFileSync(join(dir, `${name}.mjs`), source);
    writeFileSync(
      join(dir, name),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, `${name}.mjs`))} "$@"\n`,
      { mode: 0o755 },
    );
  };
  program(
    "restic",
    `
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
const target = args[args.indexOf("--target") + 1];
const dump = Buffer.from("stub-dump");
const manifest = ${JSON.stringify(manifest)};
manifest.dump.bytes = dump.length;
manifest.dump.sha256 = createHash("sha256").update(dump).digest("hex");
mkdirSync(target, { recursive: true });
writeFileSync(target + "/kajianq-${label}.dump", dump);
writeFileSync(target + "/kajianq-${label}.manifest.json", JSON.stringify(manifest));
`,
  );
  program(
    "pg_restore",
    `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(
  process.env.PROBE_MARKER,
  JSON.stringify({
    database: args[args.indexOf("-d") + 1],
    PGDATABASE: process.env.PGDATABASE,
    PGHOST: process.env.PGHOST,
    PGPORT: process.env.PGPORT,
  }),
);
`,
  );
  program("psql", "process.exit(0);\n");
  return { dir, marker, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The record the backup job writes, as key=value lines the bash preflight reads. */
function provenanceRecord({
  status = "0",
  started = 1000,
  completed = 3000,
  label = "daily-20261018t031500z",
  revision = "deadbeef",
} = {}) {
  return [
    `status=${status}`,
    `started_at=${started}`,
    `completed_at=${completed}`,
    `label=${label}`,
    `revision=${revision}`,
    "",
  ].join("\n");
}

/**
 * The deployed provenance check run against one box state. The unit file and the record are real,
 * so `stat` and the mtime comparison run exactly as they do on the box. `systemctl` is stubbed and
 * reports a healthy run by default: a check that still trusts it would pass the absent-record case,
 * which is the reboot bug this check exists to close.
 */
function provenanceFixture() {
  const dir = mkdtempSync(join(tmpdir(), "kajianq-provenance-"));
  const unit = join(dir, "kajianq-backup.service");
  writeFileSync(unit, "[Unit]\nDescription=fixture\n");
  utimesSync(unit, 2000, 2000);
  const record = join(dir, "backup-provenance");
  const marker = join(dir, "kajianq-backup-pending");
  writeFileSync(marker, "#!/bin/sh\n", { mode: 0o755 });
  const realCat = spawnSync("sh", ["-c", "command -v cat"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(
    join(dir, "systemctl"),
    `#!/bin/sh
case "$*" in
  *ExecMainExitTimestamp*) printf '@%s\\n' "\${STUB_EXITED-3000}" ;;
  *ExecMainStatus*) printf '%s\\n' "\${STUB_STATUS:-0}" ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  // A failing `cat` simulates an unreadable record without relying on file modes, which a root
  // test runner would ignore.
  writeFileSync(
    join(dir, "cat"),
    `#!/bin/sh
if [ -n "\${STUB_CAT_FAIL:-}" ]; then exit 1; fi
exec ${JSON.stringify(realCat)} "$@"
`,
    { mode: 0o755 },
  );
  return {
    dir,
    unit,
    record,
    marker,
    writeRecord: (fields = {}) => writeFileSync(record, provenanceRecord(fields)),
    run: ({
      unitFile = unit,
      recordFile = record,
      markerFile = marker,
      exited,
      status,
      catFail = false,
    } = {}) =>
      spawnSync(
        "/bin/bash",
        [
          resolve(process.cwd(), "provision/vps/deploy/backup-provenance.sh"),
          unitFile,
          recordFile,
          markerFile,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            STUB_EXITED: exited ?? "3000",
            STUB_STATUS: status ?? "0",
            STUB_CAT_FAIL: catFail ? "1" : "",
          },
        },
      ),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * The deploy's migration preflight, run as the file deploy.sh runs. `ssh` and `bun`
 * are stubs on PATH: the tunnel stub binds the loopback port the DSN names,
 * records its argv, and records that the check closed it; the status stub prints
 * a fixture `db:status:all:json` report and exits with a fixture status. No test
 * reaches a real host or database, and the port is the OS's, so parallel workers
 * cannot collide.
 *
 * The ssh stub redirects its own stdout/stderr and never inherits the test's
 * pipes: a regression that leaves the tunnel running must redden the closure
 * assertions, not deadlock `spawnSync` on a pipe the surviving ssh still holds.
 */
function migrationFixture() {
  const dir = mkdtempSync(join(tmpdir(), "kajianq-migration-"));
  const statusFile = join(dir, "status.txt");
  const ready = join(dir, "tunnel-ready");
  const cleaned = join(dir, "tunnel-cleaned");
  const statusRan = join(dir, "status-ran");
  const sshArgv = join(dir, "ssh-argv");
  const sshPid = join(dir, "ssh-pid");
  const sshLog = join(dir, "ssh.log");
  const killCount = join(dir, "kill-count");
  writeFileSync(statusFile, "");
  writeFileSync(
    join(dir, "ssh.mjs"),
    `import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
if (process.env.STUB_SSH_MODE === "fail") process.exit(1);
writeFileSync(process.env.STUB_SSH_PID, String(process.pid));
writeFileSync(process.env.STUB_SSH_ARGV, process.argv.slice(2).join(" "));
const args = process.argv.slice(2);
const forward = args[args.indexOf("-L") + 1];
const local = Number(forward.split(":")[1]);
const server = createServer(() => {});
server.listen(local, "127.0.0.1", () => writeFileSync(process.env.STUB_SSH_READY, "ready"));
const bye = () => {
  writeFileSync(process.env.STUB_SSH_CLEANED, "cleaned");
  server.close(() => process.exit(0));
};
process.on("SIGTERM", bye);
process.on("SIGINT", bye);
`,
  );
  writeFileSync(
    join(dir, "ssh"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, "ssh.mjs"))} "$@" >"$STUB_SSH_LOG" 2>&1\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "bun"),
    `#!/bin/sh\ntouch "$STUB_STATUS_RAN"\ncat "$STUB_STATUS_FILE"\nexit "\${STUB_STATUS_EXIT:-0}"\n`,
    { mode: 0o755 },
  );
  // BASH_ENV sourced by the check: the first `kill -0` holds the readiness loop
  // until the ssh stub is listening, so the readiness probe succeeds on that
  // attempt; every later `kill -0` reports the tunnel dead. That puts the death
  // between the probe and the ledger read without racing the stub's startup.
  writeFileSync(
    join(dir, "kill-after-ready.sh"),
    `kill() {
  if [ "\${1:-}" != "-0" ]; then
    builtin kill "$@"
    return
  fi
  count=0
  if [ -f ${JSON.stringify(killCount)} ]; then
    count=$(cat ${JSON.stringify(killCount)})
  fi
  count=$((count + 1))
  printf '%s' "$count" >${JSON.stringify(killCount)}
  if [ "$count" -eq 1 ]; then
    tries=0
    while [ ! -e "\${STUB_SSH_READY}" ] && [ "$tries" -lt 100 ]; do
      sleep 0.02
      tries=$((tries + 1))
    done
    builtin kill -0 "\${2:-}"
    return
  fi
  return 1
}
`,
  );
  const env = (extra = {}) => ({
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    STUB_STATUS_FILE: statusFile,
    STUB_STATUS_RAN: statusRan,
    STUB_SSH_READY: ready,
    STUB_SSH_CLEANED: cleaned,
    STUB_SSH_ARGV: sshArgv,
    STUB_SSH_PID: sshPid,
    STUB_SSH_LOG: sshLog,
    ...extra,
  });
  return {
    dir,
    cleaned,
    ready,
    statusRan,
    sshArgv,
    killAfterReady: join(dir, "kill-after-ready.sh"),
    env,
    writeStatus: (lines) => writeFileSync(statusFile, `${lines.join("\n")}\n`),
    run: (args = [], extra = {}) =>
      spawnSync(
        "/bin/bash",
        [resolve(process.cwd(), "provision/vps/deploy/migration-check.sh"), ...args],
        { encoding: "utf8", env: env(extra), timeout: 15_000, killSignal: "SIGKILL" },
      ),
    cleanup: () => {
      // A stub the script under mutation left running is this fixture's child:
      // kill it, or it holds the port past the test.
      try {
        process.kill(Number(readFileSync(sshPid, "utf8")), "SIGKILL");
      } catch {
        // No stub ran, or it is already gone.
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A port nothing listens on, chosen by the OS, for the fixture's loopback DSN. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** The real migration names per set, in the order each set's `status` lists them. */
const MIGRATION_SETS = [
  ["0001_init.sql", "0002_eval_results_question_id_text.sql", "0003_feedback_dedup.sql"],
  ["0001_concept_graph.sql", "0002_aligned_pairs.sql"],
  ["0001_product.sql", "0002_admin_access_log.sql", "0003_admin_session_revocations.sql"],
];

/**
 * A `db:status:all:json` report over the real migration names, composed by the
 * producer's own formatter: a hand-written copy of the producer's format would
 * let parser and producer drift apart while every case here stayed green.
 */
function migrationStatus({ pending = [] } = {}) {
  const known = MIGRATION_SETS.flat();
  for (const name of pending) {
    if (!known.includes(name)) throw new Error(`fixture: unknown migration ${name}`);
  }
  return MIGRATION_SETS.flatMap((names) => {
    const applied = new Set(names.filter((name) => !pending.includes(name)));
    return statusLines(names, applied, { json: true });
  });
}

/** The 0600 env file deploy.sh sources: the box's values, and optionally the DSN. */
function deployEnv({
  port,
  databaseUrl = `postgres://kajianq:secret@127.0.0.1:${port}/kajianq`,
} = {}) {
  const lines = [
    "KAJIANQ_DEPLOY_HOST=example.test",
    "KAJIANQ_DEPLOY_USER=kajianq-deploy",
    "KAJIANQ_DEPLOY_ROOT=/srv/kajianq",
    "KAJIANQ_PUBLIC_URL=https://example.test",
  ];
  if (databaseUrl) lines.push(`DATABASE_URL=${databaseUrl}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The production backup job run against stub external tools, with `--record` pointed into the
 * fixture. The tests may not hand-write a record and then call the reader: this fixture is the
 * writer half of the contract, so the file the preflight reads is the file the job produced.
 */
function backupRunFixture() {
  const dir = mkdtempSync(join(tmpdir(), "kajianq-backup-run-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const record = join(dir, "backup-provenance");
  const passFile = join(dir, "restic.pass");
  writeFileSync(passFile, "stub-passphrase\n", { mode: 0o600 });
  const program = (name, body) =>
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  program(
    "pg_dump",
    `case "$1" in
  --version) printf 'pg_dump (PostgreSQL) 16.0\\n'; exit 0 ;;
esac
file=""
while [ $# -gt 0 ]; do case "$1" in --file) file="$2"; shift 2 ;; *) shift ;; esac; done
printf 'stub-dump' > "$file"
# Let a test observe the record as it exists while the dump is running.
if [ -n "\${STUB_OBSERVE_RECORD:-}" ] && [ -f "\${STUB_RECORD_FILE:-}" ]; then
  cp "\${STUB_RECORD_FILE}" "\${STUB_OBSERVE_RECORD}"
fi`,
  );
  program(
    "psql",
    `case "$*" in
  *"SHOW server_version"*) printf '16.0\\n' ;;
  *pg_stat_user_tables*) printf 'users|3\\nsessions|2\\n' ;;
esac
exit 0`,
  );
  program(
    "restic",
    `if [ "\${STUB_RESTIC_INTERRUPT:-0}" = "1" ]; then
  # The job is blocked in this spawn; SIGTERM it from here to leave exactly the state a systemd
  # timeout or an operator's Ctrl-C leaves: the start marker, no completion.
  kill -TERM "$PPID"
  sleep 1
  exit 143
fi
if [ "\${STUB_RESTIC_FAIL:-0}" = "1" ]; then printf 'stub restic failure\\n' >&2; exit 1; fi
exit 0`,
  );
  return {
    dir,
    record,
    run: ({
      resticFail = false,
      interrupt = false,
      observeRecord = "",
      missingEnv = false,
    } = {}) => {
      // No systemd invocation marker: the writer's authority is the root-owned directory, not an
      // environment variable. Stripping it here also keeps the bootstrap test honest on a runner
      // that happens to be started by systemd.
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PGDATABASE_URL: "postgres://stub:stub@127.0.0.1:5432/kajianq",
        RESTIC_REPOSITORY: join(dir, "repo"),
        RESTIC_PASSWORD_FILE: passFile,
        TMPDIR: dir,
        STUB_RECORD_FILE: record,
        STUB_OBSERVE_RECORD: observeRecord,
        STUB_RESTIC_FAIL: resticFail ? "1" : "0",
        STUB_RESTIC_INTERRUPT: interrupt ? "1" : "0",
      };
      delete env.INVOCATION_ID;
      // The unit's EnvironmentFile is optional, so a missing backup.env reaches the job as an
      // empty environment instead of failing the unit before ExecStartPre. The job must refuse
      // that run itself, and the record it writes is what the preflight then refuses.
      if (missingEnv) {
        for (const key of REQUIRED_ENV) delete env[key];
      }
      return spawnSync(
        process.execPath,
        [
          resolve(process.cwd(), "provision/vps/backup/kajianq-backup.mjs"),
          "--label",
          "daily-20261018t031500z",
          "--record",
          record,
        ],
        { encoding: "utf8", env },
      );
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("retention policy matches the Art. 30 record's §6 values", () => {
  it("keeps one backup per day for 30 days — the session TTL, so a backup cannot outlive its data", () => {
    expect(BACKUP_KEEP_DAILY).toBe(30);
    expect(retentionArgs()).toEqual(["forget", "--keep-daily", "30", "--prune"]);
  });

  it("prunes, so the window is enforced rather than merely reported", () => {
    // Without --prune restic keeps the snapshots it "forgot" and the storage grows unbounded.
    expect(retentionArgs()).toContain("--prune");
  });

  it("rejects a nonsensical window instead of silently disabling retention", () => {
    expect(() => retentionArgs(0)).toThrow(/positive integer/);
    expect(() => retentionArgs(1.5)).toThrow(/positive integer/);
  });

  it("uses a 14-day log window, the value the Art. 30 record declares", () => {
    expect(LOG_RETENTION_DAYS).toBe(14);
  });
});

describe("backup labels", () => {
  it("accepts the labels the CLI generates and the runbook uses", () => {
    for (const label of [
      "drill",
      "daily-20260919t031500z",
      "pre-ingest-20260912T121320Z".toLowerCase(),
    ]) {
      expect(readLabel(label)).toBe(label);
    }
  });

  it("rejects a label that would be unsafe as a file or restic tag name", () => {
    for (const bad of ["", "A", "Daily Backup", "../etc", "daily/2026"]) {
      expect(() => readLabel(bad)).toThrow();
    }
    expect(LABEL_RE.test("drill")).toBe(true);
  });

  it("namespaces the restic tag so a label cannot collide with a path", () => {
    expect(labelTag("drill")).toBe("label:drill");
  });
});

describe("manifest round-trip and validation", () => {
  it("records the dump identity and never credentials", () => {
    expect(MANIFEST.dump.sha256).toBe("a".repeat(64));
    expect(MANIFEST.dump.bytes).toBe(4096);
    expect(MANIFEST.source).toEqual({ host: "db.internal", database: "kajianq" });
    // The manifest is uploaded next to the dump, so a password in it would be a credential
    // in the backup target.
    expect(JSON.stringify(MANIFEST)).not.toMatch(/password|PGPASSWORD/i);
  });

  it("accepts its own manifest", () => {
    expect(assertManifest(MANIFEST)).toBe(MANIFEST);
  });

  it("rejects a manifest missing the identity fields a restore depends on", () => {
    expect(() => assertManifest(null)).toThrow(/not an object/);
    expect(() => assertManifest({ ...MANIFEST, label: "NOPE" })).toThrow(/valid label/);
    expect(() => assertManifest({ ...MANIFEST, dump: undefined })).toThrow(/sha256/);
    expect(() => assertManifest({ ...MANIFEST, dump: { sha256: "short", bytes: 1 } })).toThrow(
      /sha256/,
    );
    expect(() => assertManifest({ ...MANIFEST, dump: { ...MANIFEST.dump, bytes: 0 } })).toThrow(
      /size/,
    );
    expect(() => assertManifest({ ...MANIFEST, tableCounts: undefined })).toThrow(/tableCounts/);
  });
});

describe("restore verification", () => {
  const actual = (over = {}) => ({
    bytes: MANIFEST.dump.bytes,
    sha256: MANIFEST.dump.sha256,
    counts: { ...MANIFEST.tableCounts },
    ...over,
  });

  it("passes a faithful restore", () => {
    const verdict = verifyRestore(MANIFEST, actual());
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it("fails on a truncated dump — the size and hash both catch it", () => {
    const verdict = verifyRestore(MANIFEST, actual({ bytes: 1024, sha256: "b".repeat(64) }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/size mismatch/),
        expect.stringMatching(/sha256 mismatch/),
      ]),
    );
  });

  it("fails when a table is missing entirely — a restore that dropped it is not faithful", () => {
    const counts = { ...MANIFEST.tableCounts };
    delete counts.users;
    const verdict = verifyRestore(MANIFEST, actual({ counts }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toEqual([expect.stringMatching(/users is absent/)]);
  });

  it("fails on ANY row-count drift, including append-only tables the corpus CLI treats loosely", () => {
    // pg-conn.mjs's CORPUS_TABLES partition compares a manifest to a LIVE database; a fresh
    // restore has nothing else writing to it, so every table is strict here.
    const verdict = verifyRestore(
      MANIFEST,
      actual({ counts: { ...MANIFEST.tableCounts, answer_traces: 4 } }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toEqual([expect.stringMatching(/answer_traces manifest=5 restored=4/)]);
  });
});

describe("erasure a restore must re-apply", () => {
  it("reclaims exactly what the nightly cron reclaims, statement for statement", () => {
    // The restore's reclamation and cleanupExpiredSessions must not drift: if the adapter's
    // SQL changes, this test fails and points at the restore path. The adapter binds its
    // cutoff as a parameter while RECLAIM_SQL uses `now()` — the same predicate — so the
    // comparison normalizes the bound value and whitespace before matching.
    const normalize = (text) =>
      text
        .replace(/\s+/g, " ")
        .replace(/\$\{before\.toISOString\(\)\}/g, "now()")
        .trim();
    const adapter = normalize(
      readFileSync(
        resolve(process.cwd(), "packages/infra/src/rag-store-postgres-session.ts"),
        "utf8",
      ),
    );
    for (const statement of RECLAIM_SQL) {
      expect(adapter, statement).toContain(normalize(statement));
    }
  });

  it("deletes the anonymous users left with no session, not just the expired tokens", () => {
    // The FK cascade runs user → session, never the reverse: without this second
    // statement an abandoned browser leaves permanent users/chat/trace rows.
    const orphan = RECLAIM_SQL.find((s) => s.includes("NOT EXISTS"));
    expect(orphan).toBeDefined();
    expect(orphan).toMatch(/kind = 'anonymous'/);
  });

  /** The tables a batch sweeps, in order, and the tables it verifies. */
  const erasedTables = (sql) => [...sql.matchAll(/DELETE FROM ([a-z_]+)/g)].map((m) => m[1]);
  const verifiedTables = (sql) => [
    ...new Set([...sql.matchAll(/SELECT '([a-z_]+)' AS verified_table/g)].map((m) => m[1])),
  ];
  const adapterErasure = () =>
    readFileSync(
      resolve(process.cwd(), "packages/infra/src/rag-store-postgres-erasure.ts"),
      "utf8",
    );

  /**
   * The adapter's sweep statements, normalised to compare with the restore's: the
   * SQL the adapter interpolates the id into becomes the psql variable the batch
   * binds, whitespace collapses, and the statement terminator the template leaves
   * to its runner is dropped. Only the `sql` tagged bodies that are a `DELETE`
   * count — the `set_config` bind and the `DO` blocks are not sweeps.
   */
  const adapterSweeps = (text) =>
    [...text.matchAll(/sql`([\s\S]*?)`/g)]
      .map((match) =>
        match[1]
          .replace(/\s+/g, " ")
          .replace(/\$\{userId\}/g, ":'uid'")
          .trim()
          .replace(/;$/, ""),
      )
      .filter((statement) => statement.startsWith("DELETE FROM"));

  /** The restore's sweep lines, normalised the same way the adapter's are. */
  const restoreSweeps = (text) =>
    text
      .split("\n")
      .map((line) =>
        line
          .replace(/\s+/g, " ")
          .replace(/\$\{userId\}/g, ":'uid'")
          .trim()
          .replace(/;$/, ""),
      )
      .filter((statement) => statement.startsWith("DELETE FROM"));

  /** The `DO` blocks in a batch, in order. */
  const doBlocks = (text) => [...text.matchAll(/DO \$\$[\s\S]*?END \$\$/g)].map((m) => m[0]);

  /**
   * Strip a `--` comment from one SQL line, quote-aware: inside a single-quoted
   * literal a `--` is data, not the start of a comment, so the text after it stays
   * in the comparison. A quote is escaped by doubling it (`'it''s -- data'`), so a
   * doubled quote is skipped rather than read as one literal closing and the next
   * opening.
   */
  const stripSqlComment = (line) => {
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === "'") {
        if (quoted && line[i + 1] === "'") {
          i += 1;
          continue;
        }
        quoted = !quoted;
        continue;
      }
      if (!quoted && line[i] === "-" && line[i + 1] === "-") return line.slice(0, i);
    }
    return line;
  };

  /**
   * One residual assertion block in comparable form: `--` comment text is stripped
   * per line before the lines are joined (a comment runs to the end of its line, so
   * stripping after the join would let a commented-out predicate and a live one
   * normalise to the same text), then blank lines, leading/trailing whitespace and
   * the trailing statement terminator are dropped. Internal spacing and literals
   * stay verbatim, including a `--` inside a literal, which is data.
   */
  const normalizeBlock = (block) =>
    block
      .split("\n")
      .map((line) => stripSqlComment(line).trim())
      .filter(Boolean)
      .join(" ")
      .replace(/;$/, "");

  it("the Art. 17 batch matches production deleteUserCascade in both directions — the restore path cannot drift", () => {
    // Production erasure (DELETE /v1/auth/me → deleteUserCascade) sweeps and verifies each
    // table of the subtree inside one transaction; the restore re-applies the same statements
    // with the id bound as a psql variable. Both sets are compared BOTH ways, so a table swept
    // in one path and not the other reddens here whichever side it was added to.
    const adapter = adapterErasure();
    const restore = erasureSql();
    const adapterSwept = erasedTables(adapter).sort();
    const restoreSwept = erasedTables(restore).sort();
    expect(restoreSwept).toEqual(adapterSwept);
    // Five child tables plus the user row: a set that silently shrinks (a sweep dropped) or
    // grows (a sweep added to one path) fails here.
    expect(adapterSwept).toEqual([
      "answer_traces",
      "chat_messages",
      "chat_sessions",
      "feedback",
      "sessions",
      "users",
    ]);
    // Every swept table is verified, and the restore verifies the same set production does.
    expect(verifiedTables(restore).sort()).toEqual([...adapterSwept].sort());
    expect(verifiedTables(adapter).sort()).toEqual([...adapterSwept].sort());
    // And each restore sweep is production's statement, statement for statement. The comparison
    // is equality, not containment: a restore statement that drops its predicate is a substring
    // of the adapter's (`DELETE FROM feedback` in `DELETE FROM feedback WHERE user_id = …`) and
    // would satisfy a one-directional check, so the two lists are compared element by element.
    expect(restoreSweeps(restore)).toEqual(adapterSweeps(adapter));
  });

  it("reddens on a dropped sweep predicate in either direction — the comparison is equality, not containment", () => {
    // An adapter-side predicate change and a restore-side one both move a list element; a
    // dropped predicate does not shorten the adapter list, it makes the two lists differ.
    const adapter = adapterSweeps("sql`DELETE FROM feedback WHERE user_id = ${userId}`");
    expect(restoreSweeps("DELETE FROM feedback WHERE user_id = :'uid';")).toEqual(adapter);
    expect(restoreSweeps("DELETE FROM feedback;")).not.toEqual(adapter);
    expect(adapterSweeps("sql`DELETE FROM feedback`")).not.toEqual(
      restoreSweeps("DELETE FROM feedback WHERE user_id = :'uid';"),
    );
  });

  it("the restore assertions are production's DO blocks, predicate for predicate — a weakened restore predicate reddens", () => {
    // The sweep comparison above pins the DELETE predicates; the residual assertions are
    // what turn a surviving row into a non-zero exit, and their predicates live in the DO
    // blocks. Whole blocks are compared, so a weakened predicate cannot hide behind a marker
    // that is still spelled. Normalisation strips `--` comment text per line (a comment runs
    // to the end of its line), then per-line leading/trailing whitespace, blank lines, and the
    // trailing statement terminator the adapter's template leaves to its runner and psql's
    // batch spells; internal spacing and literals are compared verbatim, so
    // `WHERE EXISTS (…)` against `WHERE false` is a difference.
    const adapterBlocks = doBlocks(adapterErasure()).map(normalizeBlock);
    const restoreBlocks = doBlocks(erasureSql()).map(normalizeBlock);
    expect(adapterBlocks).toHaveLength(2);
    expect(restoreBlocks).toHaveLength(2);
    // Positional comparison, so the `chat_messages` assertion must stay the block before the
    // `chat_sessions` sweep (the ordering test below pins that) and the subtree assertion the
    // block after the `users` delete.
    expect(restoreBlocks[0]).toContain("'chat_messages' AS verified_table");
    expect(restoreBlocks[1]).toContain("'users' AS verified_table");
    expect(restoreBlocks).toEqual(adapterBlocks);
  });

  it("keeps `--` comment scope when comparing the assertion blocks", () => {
    // The blocks are compared after their lines are joined, so a comment must be stripped
    // before the join: `-- scope AND false` comments the predicate out, while `-- scope` on
    // its own line followed by `AND false` leaves it live. Joining first would make the two
    // the same text and the pin green against an assertion turned into a no-op.
    const commentedOut = [
      "DO $$",
      "BEGIN",
      "  IF EXISTS (SELECT 1) -- scope AND false",
      "  THEN NULL;",
      "  END IF;",
      "END $$",
    ].join("\n");
    const live = [
      "DO $$",
      "BEGIN",
      "  IF EXISTS (SELECT 1) -- scope",
      "  AND false THEN NULL;",
      "  END IF;",
      "END $$",
    ].join("\n");
    expect(normalizeBlock(commentedOut)).not.toBe(normalizeBlock(live));
    // A comment's own text is not part of the predicate: two blocks that differ only in a
    // comment are equal, so re-wording one does not redden the pin.
    expect(normalizeBlock("DO $$\nBEGIN\n  NULL; -- note\nEND $$")).toBe(
      normalizeBlock("DO $$\nBEGIN\n  NULL;\nEND $$"),
    );
  });

  it("keeps a `--` inside a literal in the comparison, so a difference after it reddens", () => {
    // A quote-unaware strip truncates the line at the literal's `--` on both sides, so a
    // difference after it disappears and a weakened assertion pins green. The strip follows
    // single-quoted literals, including their doubled-quote escapes.
    const block = (tail) =>
      [
        "DO $$",
        "BEGIN",
        "  IF EXISTS (SELECT 1 WHERE note = 'it''s -- data" + tail + "') THEN NULL;",
        "  END IF;",
        "END $$",
      ].join("\n");
    expect(normalizeBlock(block(" x"))).not.toBe(normalizeBlock(block("")));
    // A `--` outside a literal still starts a comment, whatever the comment's text
    // contains — quotes in a comment do not reopen a literal.
    expect(normalizeBlock("DO $$\nBEGIN\n  NULL; -- note 'it''s'\nEND $$")).toBe(
      normalizeBlock("DO $$\nBEGIN\n  NULL;\nEND $$"),
    );
  });

  it("asserts the postcondition inside the restore transaction, so a residual fails the run", () => {
    const batch = erasureSql();
    // The same failing statement production gets: 23514 aborts the transaction, and psql runs
    // the batch with ON_ERROR_STOP=1, so a surviving row exits non-zero before COMMIT instead
    // of being reported as an applied erasure.
    expect(batch.match(/ERRCODE = '23514'/g)).toHaveLength(2);
    expect(batch).not.toMatch(/\bSELECT count\(\*\)/);
  });

  it("re-applies erasure in one transaction, sweeping children before the parent", () => {
    const batch = erasureSql();
    const lines = batch.split("\n");
    // A failed statement must not leave the scratch target half-erased: the batch is one
    // transaction (psql runs it with ON_ERROR_STOP=1, so a failure aborts before COMMIT).
    expect(lines[0]).toBe("BEGIN;");
    expect(lines.at(-1)).toBe("COMMIT;");
    // The parent delete runs last of the deletes: its FK cascade is the backstop for anything
    // committed between a child sweep and the user delete. The subtree assertion follows it,
    // still inside the transaction.
    const parent = lines.findIndex((line) => line.startsWith("DELETE FROM users"));
    const lastChild = lines.reduce(
      (last, line, i) => (line.startsWith("DELETE FROM") && i !== parent ? i : last),
      0,
    );
    expect(parent).toBeGreaterThan(lastChild);
    expect(lines.slice(parent + 1).join("\n")).toContain("SELECT 'users' AS verified_table");
    // `chat_messages` is verified between its own sweep and the `chat_sessions` delete — the
    // only point where its transitive owner can still be read.
    const messagesSweep = lines.findIndex((line) => line.startsWith("DELETE FROM chat_messages"));
    const messagesAssert = lines.findIndex((line) =>
      line.includes("SELECT 'chat_messages' AS verified_table"),
    );
    const sessionsSweep = lines.findIndex((line) => line.startsWith("DELETE FROM chat_sessions"));
    expect(messagesSweep).toBeLessThan(messagesAssert);
    expect(messagesAssert).toBeLessThan(sessionsSweep);
  });

  it("binds the erasure user id as a psql variable, never into the statement text", () => {
    // Fixed text: the id travels in erasurePsqlArgs, quoted by psql itself, and every sweep
    // binds it the same way (the six deletes plus the transaction-local setting the assertions
    // read back).
    expect(erasureSql().match(/:'uid'/g)).toHaveLength(7);
    expect(erasureSql()).not.toMatch(/\$\{/);
    // The assertions read the setting the batch seeds, and never a literal id.
    const settings = new Set(
      [...erasureSql().matchAll(/'kajianq\.erasure\.[a-z_]+'/g)].map((m) => m[0]),
    );
    expect([...settings]).toEqual(["'kajianq.erasure.subject'"]);
    expect(erasurePsqlArgs("33333333-3333-4333-8333-333333333333")).toEqual([
      "-v",
      "uid=33333333-3333-4333-8333-333333333333",
    ]);
    // A non-UUID is refused before it can reach psql at all.
    for (const bad of ["", "1 OR 1=1", "not-a-uuid", "'; DROP TABLE users; --"]) {
      expect(() => erasurePsqlArgs(bad)).toThrow(/UUID/);
    }
  });

  it("sends psql statements on stdin — :var substitution only works for script input", () => {
    // psql substitutes `:'var'` in script input (-f/stdin), never in `-c` command text, so
    // statements travel on stdin — which also keeps SQL off the process table's argv.
    const restore = readFileSync(
      resolve(process.cwd(), "provision/vps/backup/kajianq-restore.mjs"),
      "utf8",
    );
    expect(restore).toMatch(/"-f",\s*"-"/);
    expect(restore).toMatch(/input:\s*statement/);
    expect(restore).not.toMatch(/"-c",\s*statement/);
    const drill = readFileSync(
      resolve(process.cwd(), "provision/vps/backup/restore-drill.mjs"),
      "utf8",
    );
    expect(drill).toMatch(/psqlVar\(sourceUrl, erasureSql\(\), erasurePsqlArgs\(SUBJECT\)\)/);
  });

  it("compares connection URLs by database location, not by string (the live-URL guard)", () => {
    // The `--target-url` guard must refuse a URL that NAMES the live database even when
    // written differently (default port omitted, another scheme or credentials), and must not
    // compare secrets: a raw-string comparison fails both ways.
    expect(
      isSameDatabase(
        "postgres://u:p@127.0.0.1:5432/kajianq",
        "postgresql://other:secret@127.0.0.1/kajianq?sslmode=require",
      ),
    ).toBe(true);
    expect(
      isSameDatabase(
        "postgres://u:p@127.0.0.1:5432/kajianq",
        "postgres://u:p@127.0.0.1:5433/kajianq",
      ),
    ).toBe(false);
    expect(
      isSameDatabase(
        "postgres://u:p@127.0.0.1:5432/kajianq",
        "postgres://u:p@127.0.0.1:5432/kajianq_restored",
      ),
    ).toBe(false);
    // Query parameters are dropped, not ordered: they change how a connection is made, not
    // which database it reaches.
    expect(
      isSameDatabase(
        "postgres://u:p@127.0.0.1:5432/kajianq?sslmode=require&application_name=a",
        "postgres://u:p@127.0.0.1:5432/kajianq?application_name=a&sslmode=require",
      ),
    ).toBe(true);
    // Parsing fails closed: an unparseable or non-postgres target can never pass the guard.
    expect(() => dbLocation("not a url")).toThrow(/parseable/);
    expect(() => dbLocation(null)).toThrow(/parseable/);
    expect(() => dbLocation("mysql://u:p@127.0.0.1/kajianq")).toThrow(/postgres/);
    expect(dbLocation("postgres://u:p@db.example:5432/kajianq")).toEqual({
      protocol: "postgres:",
      host: "db.example",
      port: "5432",
      database: "kajianq",
    });
    // …and the guard itself, asserted rather than described: a live database in ANY of those
    // spellings is refused through `resolveScratchTarget` — the one path both forms take —
    // while a real scratch target passes it unchanged. Deleting the comparison from lib.mjs
    // reddens here, not only at the spawned-CLI cases below.
    const live = "postgres://u:p@127.0.0.1:5432/kajianq";
    const scratch = "postgres://u:p@127.0.0.1:5432/kajianq_restored";
    for (const spelling of [
      "postgresql://other:secret@127.0.0.1/kajianq", // other scheme, default port omitted
      "postgres://someone-else:hunter2@127.0.0.1:5432/kajianq", // other credentials
      "postgres://u:p@127.0.0.1:5432/kajianq?sslmode=require", // same location, query added
      "postgres://u:p@127.0.0.1:5432/kajianq?application_name=a&sslmode=require", // reordered
    ]) {
      expect(() =>
        resolveScratchTarget({ flagTarget: spelling, env: { PGDATABASE_URL: live } }),
      ).toThrow(/names the live database/);
      expect(() =>
        resolveScratchTarget({ env: { PGDATABASE_URL: live, RESTORE_TARGET_URL: spelling } }),
      ).toThrow(/names the live database/);
    }
    expect(resolveScratchTarget({ flagTarget: scratch, env: { PGDATABASE_URL: live } })).toBe(
      scratch,
    );
    expect(
      resolveScratchTarget({ env: { PGDATABASE_URL: live, RESTORE_TARGET_URL: scratch } }),
    ).toBe(scratch);
    // The CLI has exactly one resolution path: it asks `resolveScratchTarget` for the target
    // and never reads RESTORE_TARGET_URL itself (its own doc comment may name the key), so no
    // branch of the entry point can reach libpq without the guard above.
    const restore = readFileSync(
      resolve(process.cwd(), "provision/vps/backup/kajianq-restore.mjs"),
      "utf8",
    );
    const restoreCode = restore
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(restoreCode).toMatch(/resolveScratchTarget\(/);
    expect(restoreCode).not.toMatch(/RESTORE_TARGET_URL/);
    expect(restoreCode).toMatch(/--target-url/);
  });

  it("refuses a live-database target from the env form exactly as from the flag", () => {
    // The env form is not a way around the guard: RESTORE_TARGET_URL goes through the same
    // comparison --target-url does, a missing PGDATABASE_URL fails closed for both, and an
    // explicitly passed flag wins when both are present (the documented precedence).
    const live = "postgres://u:p@127.0.0.1:5432/kajianq";
    const scratch = "postgres://u:p@127.0.0.1:5432/kajianq_restored";

    expect(
      resolveScratchTarget({ env: { PGDATABASE_URL: live, RESTORE_TARGET_URL: scratch } }),
    ).toBe(scratch);
    expect(resolveScratchTarget({ flagTarget: scratch, env: { PGDATABASE_URL: live } })).toBe(
      scratch,
    );
    // The flag wins: the env value is not consulted, even when it names the live database.
    expect(
      resolveScratchTarget({
        flagTarget: scratch,
        env: { PGDATABASE_URL: live, RESTORE_TARGET_URL: live },
      }),
    ).toBe(scratch);
    // Both forms are refused, including a live database written in another spelling.
    expect(() => resolveScratchTarget({ flagTarget: live, env: { PGDATABASE_URL: live } })).toThrow(
      /names the live database/,
    );
    expect(() =>
      resolveScratchTarget({
        env: {
          PGDATABASE_URL: live,
          RESTORE_TARGET_URL: "postgresql://other:secret@127.0.0.1/kajianq",
        },
      }),
    ).toThrow(/names the live database/);
    // No target at all, and a missing live URL, both fail closed rather than skipping the guard.
    expect(() => resolveScratchTarget({ env: { PGDATABASE_URL: live } })).toThrow(
      /scratch target is required/,
    );
    expect(() => resolveScratchTarget({ env: { RESTORE_TARGET_URL: scratch } })).toThrow(
      /PGDATABASE_URL is required/,
    );
    expect(() =>
      resolveScratchTarget({ flagTarget: scratch, env: { RESTORE_TARGET_URL: live } }),
    ).toThrow(/PGDATABASE_URL is required/);
  });

  it("the restore CLI stops before restic on a missing or live target, both forms", () => {
    // Drive the real entry point: the guard runs before anything is decrypted or restored, so
    // a refactor that moved the check after the restore could not pass this. PATH is empty of
    // libpq/restic tools so "the guard let it through" is observable as a restic failure.
    const script = resolve(process.cwd(), "provision/vps/backup/kajianq-restore.mjs");
    const base = {
      PATH: "/nonexistent-bin",
      RESTIC_REPOSITORY: "/nonexistent/restic-repo",
      RESTIC_PASSWORD_FILE: "/dev/null",
    };
    const runRestore = (args, env) =>
      spawnSync(process.execPath, [script, "--label", "probe-label", ...args], {
        encoding: "utf8",
        env: { ...base, ...env },
      });
    const live = "postgres://u:p@127.0.0.1:5432/kajianq";
    const scratch = "postgres://u:p@127.0.0.1:5432/kajianq_restored";

    const refused = [
      [[], { PGDATABASE_URL: live }, /scratch target is required/],
      [[], { PGDATABASE_URL: live, RESTORE_TARGET_URL: live }, /names the live database/],
      [["--target-url", live], { PGDATABASE_URL: live }, /names the live database/],
      [[], { RESTORE_TARGET_URL: scratch }, /PGDATABASE_URL is required/],
    ];
    for (const [args, env, message] of refused) {
      const res = runRestore(args, env);
      expect(res.status, `expected a refusal for ${JSON.stringify(args)}`).toBe(1);
      expect(res.stderr).toMatch(message);
    }
    // Precedence, observed on the target that actually reaches libpq: with a live URL in the
    // environment and a scratch --target-url, the connection must be the scratch database.
    // Stubs on PATH let the run past the guard and step 1 so pg_restore records what it was
    // handed — a run that only dies at a missing restic cannot show which target won.
    const stubs = stubTools("probe-label");
    try {
      const passed = runRestore(["--target-url", scratch], {
        PATH: `${stubs.dir}:${process.env.PATH}`,
        PGDATABASE_URL: live,
        RESTORE_TARGET_URL: live,
        PROBE_MARKER: stubs.marker,
      });
      expect(passed.status, passed.stderr).toBe(0);
      expect(passed.stderr).not.toMatch(
        /names the live database|scratch target is required|PGDATABASE_URL is required/,
      );
      expect(JSON.parse(readFileSync(stubs.marker, "utf8"))).toEqual({
        database: "kajianq_restored",
        PGDATABASE: "kajianq_restored",
        PGHOST: "127.0.0.1",
        PGPORT: "5432",
      });
    } finally {
      stubs.cleanup();
    }
  });

  it("prints a restore plan that never hands a credentialed URL to a shell", () => {
    // The property, not the copy: a plan must really be printed (the positive control, so a
    // renamed or emptied command cannot pass vacuously), no line may carry a URL with
    // embedded credentials (that is what `ps` shows for the process's life), and no line may
    // hand an operator a URL variable — `$TARGET_URL` and `$DATABASE_URL` alike — to type.
    const script = resolve(process.cwd(), "packages/infra/scripts/db-snapshot.mjs");
    const plan = spawnSync("bun", [script, "restore-plan", "probe-label"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    expect(plan.status, plan.stderr).toBe(0);
    expect(plan.stdout).toContain("pg_restore");
    expect(plan.stdout).not.toMatch(CREDENTIALED_URL);
    expect(plan.stdout).not.toMatch(URL_VARIABLE);
  });

  it("teaches no restore command that carries a credentialed URL or a URL variable", () => {
    // Same invariant over what the operator is told to run: a URL — literal, or reachable
    // through a variable handed to the shell — in a documented command line is readable
    // through `ps` and kept in shell history. The section anchors are asserted before the
    // slice, so a renumbered heading fails here instead of making the subject empty and
    // passing green.
    const ops = readFileSync(resolve(process.cwd(), "docs/VPS-OPERATIONS.md"), "utf8");
    const opsAt = ops.indexOf("### 2.7");
    const opsEnd = ops.indexOf("### 2.8");
    expect(opsAt, "VPS-OPERATIONS.md: no §2.7 heading").toBeGreaterThan(-1);
    expect(opsEnd, "VPS-OPERATIONS.md: no §2.8 heading").toBeGreaterThan(-1);
    expect(opsEnd).toBeGreaterThan(opsAt);
    const setup = readFileSync(resolve(process.cwd(), "docs/VPS-SETUP.md"), "utf8");
    const setupAt = setup.indexOf("**Restoring for real**");
    const setupEnd = setup.indexOf("### Confirm the backup timer");
    expect(setupAt, "VPS-SETUP.md: no restore step").toBeGreaterThan(-1);
    expect(setupEnd, "VPS-SETUP.md: no backup-timer heading").toBeGreaterThan(-1);
    expect(setupEnd).toBeGreaterThan(setupAt);
    for (const [name, text] of [
      ["VPS-OPERATIONS §2.7", ops.slice(opsAt, opsEnd)],
      ["VPS-SETUP restore step", setup.slice(setupAt, setupEnd)],
    ]) {
      const lines = bashLines(text);
      expect(lines.trim().length, `${name}: no executable line to check`).toBeGreaterThan(0);
      expect(lines, name).not.toMatch(CREDENTIALED_URL);
      expect(lines, name).not.toMatch(URL_VARIABLE);
    }
  });

  it("names the rows the drill proves gone and the rows it proves survive", () => {
    // This pins that the drill asserts both directions: the negative control (resurrected rows
    // present) and the erase-then-match direction (erased rows gone, live rows intact). A drill
    // that only asserted one side would pass vacuously.
    const drill = readFileSync(
      resolve(process.cwd(), "provision/vps/backup/restore-drill.mjs"),
      "utf8",
    );
    expect(drill).toMatch(/assert 1 — the restore resurrects erased data/);
    expect(drill).toMatch(/assert 2 — erasure re-applied/);
    expect(drill).toMatch(/live question that must survive/);
    expect(drill).toMatch(/negative control failed/);
  });
});

describe("env handling", () => {
  it("parses an env file, skipping comments and blanks", () => {
    const parsed = parseEnvFile(
      [
        "# backup configuration",
        "",
        "RESTIC_REPOSITORY=s3:https://storage.example/kajianq",
        "RESTIC_PASSWORD_FILE=/etc/kajianq/restic.pass",
        'PGDATABASE_URL="postgres://u:p@127.0.0.1:5432/kajianq"',
        "  SPACED = trimmed  ",
      ].join("\n"),
    );
    expect(parsed.RESTIC_PASSWORD_FILE).toBe("/etc/kajianq/restic.pass");
    expect(parsed.PGDATABASE_URL).toBe("postgres://u:p@127.0.0.1:5432/kajianq");
    expect(parsed.SPACED).toBe("trimmed");
    expect(parsed["# backup configuration"]).toBeUndefined();
  });

  it("names every missing required variable instead of failing on the first", () => {
    expect(missingEnv({})).toEqual(REQUIRED_ENV);
    expect(missingEnv({ RESTIC_REPOSITORY: "r", RESTIC_PASSWORD_FILE: "p" })).toEqual([
      "PGDATABASE_URL",
    ]);
    expect(
      missingEnv({ RESTIC_REPOSITORY: "r", RESTIC_PASSWORD_FILE: "", PGDATABASE_URL: "u" }),
    ).toEqual(["RESTIC_PASSWORD_FILE"]);
  });

  it("tolerates a shell-style export prefix — a shell env file is what an operator writes", () => {
    // The file is parsed, never sourced, so `export KEY=value` must not become a key named
    // "export KEY": that read as a missing RESTORE_TARGET_URL while the value sat in the file.
    const parsed = parseEnvFile(
      [
        "export PGDATABASE_URL=postgres://u:p@127.0.0.1:5432/kajianq",
        "export   RESTORE_TARGET_URL = postgres://u:p@127.0.0.1:5432/kajianq_restored",
      ].join("\n"),
    );
    expect(parsed.PGDATABASE_URL).toBe("postgres://u:p@127.0.0.1:5432/kajianq");
    expect(parsed.RESTORE_TARGET_URL).toBe("postgres://u:p@127.0.0.1:5432/kajianq_restored");
    expect(Object.keys(parsed)).toEqual(["PGDATABASE_URL", "RESTORE_TARGET_URL"]);
  });

  it("lets the env file supply a key the environment set empty or to whitespace", () => {
    // The file `--env-file` names is the root-owned one and is authoritative for the keys in
    // it: a bare `export RESTORE_TARGET_URL=` in the operator's shell must not turn the
    // documented restore into "a scratch target is required" while the value sits in the file
    // the command just read. A real value in the environment still wins.
    const live = "postgres://u:p@127.0.0.1:5432/kajianq";
    const scratch = "postgres://u:p@127.0.0.1:5432/kajianq_restored";
    const env = { PGDATABASE_URL: live, RESTORE_TARGET_URL: "   " };
    expect(applyEnvFile(env, { PGDATABASE_URL: scratch, RESTORE_TARGET_URL: scratch })).toEqual({
      PGDATABASE_URL: live,
      RESTORE_TARGET_URL: scratch,
    });
    expect(applyEnvFile({ RESTORE_TARGET_URL: "" }, { RESTORE_TARGET_URL: scratch })).toEqual({
      RESTORE_TARGET_URL: scratch,
    });
  });

  it("drives the documented --env-file invocation end to end", () => {
    // The documented restore is `--env-file <root-owned file> --label <label>`, and the file
    // carries the target. Spawn the real CLI with no target in the environment (the shell set
    // it empty) and the export-prefixed file as the only source: the file's scratch target
    // must get past the guard and reach restic, while a live target in the same file is still
    // refused. This is the env-file path the restore drill now runs in CI, minus the server.
    const script = resolve(process.cwd(), "provision/vps/backup/kajianq-restore.mjs");
    const dir = mkdtempSync(join(tmpdir(), "kajianq-envfile-"));
    const envFile = join(dir, "backup.env");
    const live = "postgres://u:p@127.0.0.1:5432/kajianq";
    const scratch = "postgres://u:p@127.0.0.1:5432/kajianq_restored";
    const run = () =>
      spawnSync(process.execPath, [script, "--label", "probe-label", "--env-file", envFile], {
        encoding: "utf8",
        env: { PATH: "/nonexistent-bin", RESTORE_TARGET_URL: "" },
      });
    try {
      writeFileSync(
        envFile,
        [
          `export PGDATABASE_URL=${live}`,
          `export RESTORE_TARGET_URL=${scratch}`,
          "RESTIC_REPOSITORY=/nonexistent/restic-repo",
          "RESTIC_PASSWORD_FILE=/dev/null",
        ].join("\n") + "\n",
      );
      const passed = run();
      expect(passed.stderr).not.toMatch(/scratch target is required|PGDATABASE_URL is required/);
      expect(passed.stderr).toMatch(/restic/);
      // Fail-closed is unchanged: the same file naming the live database is refused.
      writeFileSync(
        envFile,
        [
          `export PGDATABASE_URL=${live}`,
          `export RESTORE_TARGET_URL=${live}`,
          "RESTIC_REPOSITORY=/nonexistent/restic-repo",
          "RESTIC_PASSWORD_FILE=/dev/null",
        ].join("\n") + "\n",
      );
      const refused = run();
      expect(refused.status).toBe(1);
      expect(refused.stderr).toMatch(/names the live database/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deploy and backup policy stays true to the ADR", () => {
  const read = (rel) => readFileSync(resolve(process.cwd(), rel), "utf8");

  it("restic never receives the repository on argv — credentials stay out of the process table", () => {
    // restic reads RESTIC_REPOSITORY from the environment; an `-r` flag would put a repository
    // URL that may embed credentials on the command line where `ps` exposes it.
    for (const file of [
      "provision/vps/backup/kajianq-backup.mjs",
      "provision/vps/backup/kajianq-restore.mjs",
      "provision/vps/backup/restore-drill.mjs",
    ]) {
      expect(readFileSync(resolve(process.cwd(), file), "utf8"), file).not.toMatch(/"-r"/);
    }
  });

  it("libpq invocations never take a connection URL on argv", () => {
    // pg_restore/psql get the database name (or nothing) and read the rest of the connection
    // from the PG* environment: a URL on argv would carry the password in the process table.
    // Assert the property over every `-d` argument rather than the name of one variable — any
    // `-d` fed something that is not a database name (a URL variable, a URL literal) reddens
    // here, and a rename of the variable the database name is read off does not.
    const restore = readFileSync(
      resolve(process.cwd(), "provision/vps/backup/kajianq-restore.mjs"),
      "utf8",
    );
    const databases = [...restore.matchAll(/"-d",\s*([^,\n]+)/g)].map((m) => m[1].trim());
    expect(
      databases.length,
      "no -d argument found — the assertion would be vacuous",
    ).toBeGreaterThan(0);
    for (const arg of databases) {
      expect(arg, `-d takes a database name, not a URL: ${arg}`).toMatch(
        /\.database$|^["'][A-Za-z0-9_-]+["']$/,
      );
    }
  });

  it("the setup doc's SQL creates the role and database the applier does not", () => {
    // The host configuration installs the Postgres posture but creates no role or database, so
    // the SQL the operator pastes from the setup doc is the artifact that provisions them:
    // assert its statements, not the sentences around them. A block that lost LOGIN, the bound
    // password or OWNER would leave the API unable to start, and nothing else in CI would notice.
    const setup = read("docs/VPS-SETUP.md");
    const sql = [...setup.matchAll(/```bash\n([\s\S]*?)```/g)]
      .map((m) => m[1])
      .find((block) => block.includes("CREATE ROLE"));
    expect(sql, "docs/VPS-SETUP.md: no block provisions the kajianq role").toBeTruthy();
    const statements = sql
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(statements).toMatch(/psql -v pw="\$DB_PW"/);
    expect(statements).toMatch(/CREATE ROLE kajianq LOGIN PASSWORD :'pw'/);
    expect(statements).toMatch(/CREATE DATABASE kajianq OWNER kajianq/);
  });

  it("the setup doc probes the admin API through the already-proxied /v1 prefix", () => {
    // The admin API adds no top-level path, so the box needs no nginx change and no
    // sudo. What a deploy must verify is that the existing `/v1` proxy reaches the
    // API: the SPA fallback answers HTML, so the content type is the evidence.
    const setup = read("docs/VPS-SETUP.md");
    expect(setup).toMatch(/Verify the admin surface reached the API/);
    expect(setup).toContain("/v1/admin/session");
    expect(setup).toMatch(/content_type/);
    expect(setup).toMatch(/application\/json/);
    expect(setup).toMatch(/text\/html/);
    expect(setup).not.toMatch(/location \/admin\//);
    // The probe is a GET and never reaches the login's origin check, so the section
    // must name the allowlist dependency and the log line that diagnoses it; otherwise
    // a box with ADMIN_PASSWORD set and ALLOWED_ORIGINS stale looks healthy while
    // login is impossible.
    const adminStart = setup.indexOf("### Verify the admin surface");
    const adminSection = setup.slice(adminStart, setup.indexOf("### Verify retention", adminStart));
    expect(adminSection).toMatch(/ALLOWED_ORIGINS/);
    expect(adminSection).toContain("admin.login_origin_refused");
  });

  it("the deploy script ships only placeholders and takes the box name from an env file", () => {
    const script = read("provision/vps/deploy/deploy.sh");
    // No hostname, IP, or credential in the repository — it is public.
    expect(script).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(script).not.toMatch(/https?:\/\/[a-z0-9.-]+\.(com|net|org|dev|id)/);
    expect(script).toMatch(/KAJIANQ_DEPLOY_HOST/);
    expect(script).toMatch(/KAJIANQ_DEPLOY_USER/);
    // The env file must be owner-only before it is sourced.
    expect(script).toMatch(/8#\$\{env_mode\} & 077/);
    // It must smoke the public URL through the proxy and run the built entries, not rebuild them.
    expect(script).toMatch(/KAJIANQ_PUBLIC_URL/);
    expect(script).toMatch(/\/v1\/health/);
    expect(script).toMatch(/boot\.ts/);
    expect(script).toMatch(/cleanup\.ts/);
  });

  it("gates only the values the script uses and treats the tree as an optional label", () => {
    // The helper's root-only contract decides the target; nothing the deploy identity can read
    // proves KAJIANQ_DEPLOY_ROOT matches it, so the label is logged, never gated.
    const script = read("provision/vps/deploy/deploy.sh");
    const required = /for var in ([^;]+); do/.exec(script)?.[1];
    expect(required, "deploy.sh must keep its required-name loop").toBeTruthy();
    expect(required.split(/\s+/)).not.toContain("KAJIANQ_DEPLOY_ROOT");
    expect(required.split(/\s+/)).toContain("KAJIANQ_DEPLOY_HOST");
    expect(required.split(/\s+/)).toContain("KAJIANQ_DEPLOY_USER");
    expect(script).toMatch(/^DEPLOY_ROOT="\$\{KAJIANQ_DEPLOY_ROOT:-\}"$/m);
    // Logged when set, never used as a path or a gate.
    expect(script).toMatch(/operator-declared target: \$\{DEPLOY_ROOT\}/);
    expect(script).not.toMatch(/mkdir[^\n]*DEPLOY_ROOT/);
    expect(script).not.toMatch(/rsync[^\n]*DEPLOY_ROOT/);
  });

  it("the deploy script builds with documented forms and smokes the SPA, not only the API", () => {
    // `bun run --cwd` relies on undocumented flag forwarding, so the web build must run via an
    // explicit subshell cd, and the smoke must fetch an extensionless client route.
    const script = read("provision/vps/deploy/deploy.sh");
    expect(script).not.toMatch(/bun run --cwd/);
    expect(script).toMatch(/cd '\$REPO_DIR' && bun run build:web/);
    expect(script).toMatch(/\$\{PUBLIC_URL\}\/chat/);
    expect(script).toMatch(/<!doctype html/);
  });

  it("passes on a record written before a reboot (mutation: the reboot clears systemd's run state)", () => {
    // The reboot case: the job wrote its record, then the box rebooted. systemd's
    // ExecMainExitTimestamp is empty and only the persistent timer stamp survived. The record
    // alone must carry the proof — the old systemd-reading check reddens on exactly this fixture.
    const backup = backupRunFixture();
    const prov = provenanceFixture();
    try {
      const ran = backup.run();
      expect(ran.status, ran.stderr).toBe(0);
      const record = readFileSync(backup.record, "utf8");
      expect(record).toMatch(/^status=0$/m);
      expect(record).toContain("label=daily-20261018t031500z");
      expect(record).toMatch(/^started_at=\d+$/m);

      const afterReboot = prov.run({ recordFile: backup.record, exited: "" });
      expect(afterReboot.status).toBe(0);
      expect(afterReboot.stdout).toContain("backup unit healthy");
    } finally {
      backup.cleanup();
      prov.cleanup();
    }
  });

  it("passes on a root bootstrap record from the checkout writer (mutation: the deployed bundle predates the writer)", () => {
    // The transition box: the deploy ships the writer, the preflight blocks the ship, and the
    // installed bundle is the pre-record one, so starting the unit cannot produce the first
    // record. The documented bootstrap is a root run of the checkout's writer with --record at
    // the production path; it does not rely on a systemd invocation marker. If that record did
    // not satisfy the gate, the box could never leave the pre-record revision.
    expect(read("provision/vps/backup/kajianq-backup.mjs")).not.toMatch(/INVOCATION_ID/);
    const backup = backupRunFixture();
    const prov = provenanceFixture();
    try {
      const setup = read("docs/VPS-SETUP.md");
      // Pin the whole documented command as one block, not each part anywhere in the doc: the
      // restore section also names --env-file, so a per-part toContain stays green after the
      // bootstrap loses that line. The order matters too: the host configuration installs the
      // unit, so a record written first is stale and cannot be cleared by the pre-record
      // deployed bundle.
      expect(setup).toContain("> cd /srv/kajianq-src");
      expect(setup).toContain(
        "sudo bun provision/vps/backup/kajianq-backup.mjs \\\n" +
          ">   --env-file /etc/kajianq/backup.env \\\n" +
          ">   --label bootstrap \\\n" +
          ">   --record /var/lib/kajianq/backup-provenance",
      );
      expect(setup).toContain("host configuration applied → bootstrap → deploy");

      const boot = backup.run();
      expect(boot.status, boot.stderr).toBe(0);
      const gate = prov.run({ recordFile: backup.record, exited: "" });
      expect(gate.status).toBe(0);
      expect(gate.stdout).toContain("backup unit healthy");
    } finally {
      backup.cleanup();
      prov.cleanup();
    }
  });

  it("refuses a missing or non-executable start marker (mutation: delete the marker)", () => {
    // The marker is the unit's pre-body half: without it a run that dies before the job body
    // leaves the previous success record current, and the record alone would pass this gate.
    // A deleted or mode-stripped marker must therefore refuse before the record is read.
    const fx = provenanceFixture();
    try {
      fx.writeRecord();
      expect(fx.run().status).toBe(0);

      const missing = fx.run({ markerFile: join(fx.dir, "no-such-marker") });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("missing or not executable");

      const stripped = join(fx.dir, "stripped-marker");
      writeFileSync(stripped, "#!/bin/sh\n", { mode: 0o644 });
      const nonExecutable = fx.run({ markerFile: stripped });
      expect(nonExecutable.status).toBe(1);
      expect(nonExecutable.stderr).toContain("missing or not executable");
    } finally {
      fx.cleanup();
    }
  });

  it("fails on a missing record (mutation: delete the record)", () => {
    // systemd still reports a healthy run. A check that reads systemd would pass here; the
    // record is gone, so the backup is unproven and the deploy must fail closed.
    const fx = provenanceFixture();
    try {
      const absent = fx.run({ exited: 3000, status: "0" });
      expect(absent.status).toBe(1);
      expect(absent.stderr).toContain("has never run");
      expect(absent.stderr).toContain("a human with root must prove it");
      expect(absent.stderr).toContain("sudo systemctl start kajianq-backup.service");
      // The remedy covers an unloaded unit too: there `systemctl start` answers "Unit ... not
      // found", which is what the daemon-reload line is for. It also points a transition box at
      // the checkout bootstrap, because starting the installed pre-record bundle cannot write a
      // record and would leave the gate red.
      expect(absent.stderr).toContain("daemon-reload");
      expect(absent.stderr).toContain("bootstrap from the checkout");
    } finally {
      fx.cleanup();
    }
  });

  it("fails on a failed run's record (mutation: record status=1)", () => {
    // The last completed run failed. systemd's stub claims success, so this row also proves the
    // record decides; the message must name the journal.
    const fx = provenanceFixture();
    try {
      fx.writeRecord({ status: "1", completed: 3000 });
      const failed = fx.run({ exited: 3000, status: "0" });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("last run exited 1");
      expect(failed.stderr).toContain("journalctl -u kajianq-backup.service -n 40");
    } finally {
      fx.cleanup();
    }
  });

  it("fails on a record older than the installed unit (mutation: move completion before install)", () => {
    // The unit was changed after the last successful run, so it has never been exercised as
    // installed — the second half of the pair, and still red.
    const fx = provenanceFixture();
    try {
      fx.writeRecord({ started: 500, completed: 1000 }); // the unit's mtime is 2000
      const stale = fx.run({ exited: 3000, status: "0" });
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain("BEFORE its current definition was installed");
      expect(stale.stderr).toContain("never been exercised as installed");
      expect(stale.stderr).toContain("as root");
      // On a transition box the stale record predates the unit the host configuration just
      // installed, and `systemctl start` still runs the pre-record bundle; the refusal must
      // point at the checkout bootstrap instead of ending at that dead end.
      expect(stale.stderr).toContain("bootstrap from the checkout");
    } finally {
      fx.cleanup();
    }
  });

  it("fails on an interrupted run's record (mutation: SIGTERM leaves started_at without a completion)", () => {
    // The start marker is the state a run killed by SIGTERM, OOM or systemd's start timeout
    // leaves. Without it the previous success stays in the file and the gate passes for a run
    // that never completed.
    const fx = provenanceFixture();
    try {
      fx.writeRecord({ status: "running", started: 3000, completed: 0 });
      const running = fx.run();
      expect(running.status).toBe(1);
      expect(running.stderr).toContain("has not recorded its completion");
      expect(running.stderr).toContain("journalctl -u kajianq-backup.service -n 40");

      // The same refused state expressed by the timestamps alone.
      fx.writeRecord({ status: "0", started: 4000, completed: 3000 });
      const backwards = fx.run();
      expect(backwards.status).toBe(1);
      expect(backwards.stderr).toContain("has not recorded its completion");
    } finally {
      fx.cleanup();
    }
  });

  it("refuses a run that dies before the job body (mutation: no pre-body marker)", () => {
    // The unit's ExecStartPre marks the record pending before ExecStart can fail (a moved bun,
    // an absent deployed bundle, a broken ExecStart), and the job body never runs to replace
    // the marker. The fixture seeds the previous success first — exactly the state a pre-body
    // death leaves current if nothing marks the run.
    const fx = provenanceFixture();
    try {
      fx.writeRecord();
      expect(fx.run().status).toBe(0);

      // The unit's ExecStartPre writes this record before ExecStart can fail.
      fx.writeRecord({ status: "pending", started: 4000, completed: 0 });
      const record = readFileSync(fx.record, "utf8");
      expect(record).toMatch(/^status=pending$/m);
      expect(record).toMatch(/^started_at=\d+$/m);
      expect(record).toMatch(/^completed_at=0$/m);

      // The job body never ran, so nothing replaced the marker. A reboot does not change the
      // verdict: the marker is in the durable record, and the stub reports the post-boot
      // systemd state (no ExecMainExitTimestamp, exit status 0) that a failed-state read would
      // have taken as healthy.
      const gate = fx.run({ exited: "" });
      expect(gate.status).toBe(1);
      expect(gate.stderr).toContain("never reached the backup job");
      expect(gate.stderr).toContain("kajianq-backup.service");
      expect(gate.stderr).toContain("journalctl -u kajianq-backup.service -n 40");
      expect(gate.stderr).toContain("sudo systemctl start kajianq-backup.service");
    } finally {
      fx.cleanup();
    }
  });

  it("treats the record as the authority (mutation: forge systemd state both ways)", () => {
    const fx = provenanceFixture();
    try {
      // Absent record + healthy systemd: red.
      const absent = fx.run({ exited: 3000, status: "0" });
      expect(absent.status).toBe(1);
      expect(absent.stderr).toContain("has never run");

      // Good record + systemd claiming a failed run with no timestamp: green.
      fx.writeRecord();
      const good = fx.run({ exited: "", status: "1" });
      expect(good.status).toBe(0);
      expect(good.stdout).toContain("backup unit healthy");
    } finally {
      fx.cleanup();
    }
  });

  it("fails closed on a malformed or unreadable record", () => {
    const fx = provenanceFixture();
    try {
      const cases = [
        [{ status: "" }, "does not record an exit status"],
        [{ status: "zero" }, "non-numeric exit status"],
        [{ started: "" }, "does not record when the last run started"],
        [{ started: "n/a" }, "non-numeric start timestamp"],
        [{ started: "9".repeat(20) }, "out-of-range start timestamp"],
        [{ completed: "" }, "does not record when the last run completed"],
        [{ completed: "n/a" }, "non-numeric completion timestamp"],
        [{ completed: "9".repeat(20) }, "out-of-range completion timestamp"],
      ];
      for (const [fields, message] of cases) {
        fx.writeRecord(fields);
        const res = fx.run();
        expect(res.status, message).toBe(1);
        expect(res.stderr).toContain(message);
      }

      // A record that cannot be read names itself instead of aborting with cat's exit status.
      const unreadable = fx.run({ catFail: true });
      expect(unreadable.status).toBe(1);
      expect(unreadable.stderr).toContain("could not read");
      expect(unreadable.stderr).toContain(fx.record);

      // A unit file that is not installed at all is named, not silently read as healthy.
      const absentUnit = fx.run({ unitFile: join(fx.dir, "absent.service") });
      expect(absentUnit.status).toBe(1);
      expect(absentUnit.stderr).toContain("is not installed");
    } finally {
      fx.cleanup();
    }
  });

  it("the backup job records its outcome, including a failed run", () => {
    const backup = backupRunFixture();
    try {
      const ok = backup.run();
      expect(ok.status, ok.stderr).toBe(0);
      const done = readFileSync(backup.record, "utf8");
      expect(done).toMatch(/^status=0$/m);
      // World-readable, and the directory is traversable: the deploy identity reads this as an
      // unprivileged user. The root ownership that makes it unforgeable is the unit's (it runs as
      // root), so only the modes are assertable here.
      expect(statSync(backup.record).mode & 0o777).toBe(0o644);
      // The writer must not widen a caller-supplied --record directory: the drill points it at
      // /tmp, and chmodding that would weaken a shared directory the job does not own.
      expect(statSync(backup.dir).mode & 0o777).toBe(0o700);
      const started = Number(/^started_at=(\d+)$/m.exec(done)[1]);
      const completed = Number(/^completed_at=(\d+)$/m.exec(done)[1]);
      expect(completed).toBeGreaterThanOrEqual(started);

      const failed = backup.run({ resticFail: true });
      expect(failed.status).toBe(1);
      const record = readFileSync(backup.record, "utf8");
      expect(record).toMatch(/^status=1$/m);
      expect(record).toContain("label=daily-20261018t031500z");
      expect(record).toMatch(/^completed_at=\d+$/m);
    } finally {
      backup.cleanup();
    }
  });

  it("marks a run in progress before the dump (mutation: a killed run leaves the previous success current)", () => {
    // The writer must mark the run before the dump. This observes the file from inside the
    // pg_dump stub, before the backup has completed.
    const backup = backupRunFixture();
    try {
      const observed = join(backup.dir, "observed-record");
      const ok = backup.run({ observeRecord: observed });
      expect(ok.status, ok.stderr).toBe(0);
      const during = readFileSync(observed, "utf8");
      expect(during).toMatch(/^status=running$/m);
      expect(during).toMatch(/^started_at=\d+$/m);
      expect(during).toMatch(/^completed_at=0$/m);
    } finally {
      backup.cleanup();
    }
  });

  it("a missing backup.env is refused with its recorded cause (mutation: required EnvironmentFile)", () => {
    // The unit's EnvironmentFile is optional so the pending marker runs before the file is
    // needed; without that, systemd fails the unit before ExecStartPre, nothing marks the run,
    // and the previous success stays current. With the marker in place the job starts, refuses
    // the run itself (naming the missing configuration), and records status=1 — the preflight
    // then refuses with the recorded cause, not only with the pending marker.
    const backup = backupRunFixture();
    const prov = provenanceFixture();
    try {
      // A previous success is current before this run, and would stay current without the
      // marker.
      writeFileSync(backup.record, provenanceRecord());
      expect(prov.run({ recordFile: backup.record }).status).toBe(0);

      writeFileSync(
        backup.record,
        provenanceRecord({ status: "pending", started: 4000, completed: 0 }),
      );
      const beforeJob = prov.run({ recordFile: backup.record, exited: "" });
      expect(beforeJob.status).toBe(1);
      expect(beforeJob.stderr).toContain("never reached the backup job");

      const bare = backup.run({ missingEnv: true });
      expect(bare.status, bare.stderr).toBe(1);
      expect(bare.stderr).toContain("missing configuration");
      const record = readFileSync(backup.record, "utf8");
      expect(record).toMatch(/^status=1$/m);
      expect(record).toMatch(/^completed_at=\d+$/m);

      const afterJob = prov.run({ recordFile: backup.record, exited: "" });
      expect(afterJob.status).toBe(1);
      expect(afterJob.stderr).toContain("last run exited 1");
    } finally {
      backup.cleanup();
      prov.cleanup();
    }
  });

  it("leaves the start marker when SIGTERM interrupts a run after a success (mutation: keep the old success)", () => {
    // The failure direction: the unit is oneshot, so a hung run stopped with SIGTERM exits 143.
    // If the record still held the previous success, the gate would stay green for a run that
    // never completed. The start marker makes the interruption visible.
    const backup = backupRunFixture();
    const prov = provenanceFixture();
    try {
      expect(backup.run().status).toBe(0);
      const interrupted = backup.run({ interrupt: true });
      expect(interrupted.signal).toBe("SIGTERM");
      const record = readFileSync(backup.record, "utf8");
      expect(record).toMatch(/^status=running$/m);
      expect(record).toMatch(/^completed_at=0$/m);

      const gate = prov.run({ recordFile: backup.record, exited: "" });
      expect(gate.status).toBe(1);
      expect(gate.stderr).toContain("has not recorded its completion");
    } finally {
      backup.cleanup();
      prov.cleanup();
    }
  });

  it("the backup-provenance check reads the durable record, never systemd runtime state", () => {
    const check = read("provision/vps/deploy/backup-provenance.sh");
    const executable = check
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    // The record is the only evidence...
    expect(executable).toMatch(/RECORD_FILE="\$\{2:-\/var\/lib\/kajianq\/backup-provenance\}"/);
    expect(executable).toMatch(/refuse\(\) \{/);
    expect(executable).toMatch(/if \[ "\$\{status\}" != "0" \][^]*?refuse/);
    expect(executable).toMatch(/stat -c %Y "\$\{UNIT_FILE\}"/);
    expect(executable).toMatch(/if \[ "\$\{completed\}" -lt "\$\{installed\}" \][^]*?refuse/);
    // ...the start/completion pair is what exposes an interrupted run...
    expect(executable).toMatch(/if \[ "\$\{status\}" = "running" \]/);
    expect(executable).toMatch(/if \[ "\$\{completed\}" -lt "\$\{started\}" \]/);
    // ...and the unit's own pre-body marker is its own refusal, not a malformed status...
    expect(executable).toMatch(/if \[ "\$\{status\}" = "pending" \][^]*?refuse/);
    // ...every value is guarded, so a garbled one cannot reach the healthy line...
    expect(executable).toMatch(/if \[ -z "\$\{started\}" \][^]*?refuse/);
    expect(executable).toMatch(/case "\$\{started\}" in\s*\*\[!0-9\]\*/);
    expect(executable).toMatch(/if \[ -z "\$\{completed\}" \][^]*?refuse/);
    expect(executable).toMatch(/case "\$\{completed\}" in\s*\*\[!0-9\]\*/);
    expect(executable).toMatch(/if \[ -z "\$\{status\}" \][^]*?refuse/);
    expect(executable).toMatch(/case "\$\{status\}" in\s*\*\[!0-9\]\*/);
    expect(executable).toMatch(/-gt 11/);
    // ...failures name the follow-up...
    expect(executable).toMatch(/journalctl -u \$\{UNIT\} -n 40/);
    // ...and no systemd runtime read may sneak back in.
    expect(executable).not.toMatch(
      /systemctl show|ExecMainStatus|ExecMainExitTimestamp|systemctl reset-failed/,
    );
    expect(executable).not.toMatch(/-p Result/);
  });

  it("reads the record once (mutation: two reads pair one write's status with another's timestamp)", () => {
    const check = read("provision/vps/deploy/backup-provenance.sh");
    const executable = check
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    // One read into a buffer, then both fields parsed from it. A per-field read would race the
    // writer's rename: a green status from record A with a fresh timestamp from record B.
    expect(executable.match(/cat -- "\$\{RECORD_FILE\}"/g)?.length ?? 0).toBe(1);
    expect(executable).toMatch(/record="\$\(cat -- "\$\{RECORD_FILE\}"\)"/);
    expect(executable).not.toMatch(/sed -n[^\n]*RECORD_FILE/);
  });

  it("the provenance record lives outside the deploy tree, root-owned and world-readable", () => {
    const backup = read("provision/vps/backup/kajianq-backup.mjs");
    const provenance = read("provision/vps/backup/provenance.mjs");
    const check = read("provision/vps/deploy/backup-provenance.sh");
    // The writer and the reader must name the same path, and it must not sit under the deploy
    // root: /srv/kajianq belongs to the helper's swap, so a root-owned record there could be
    // renamed away, and the whole tree is replaced on every deploy.
    expect(provenance).toMatch(/RECORD_DIR = "\/var\/lib\/kajianq"/);
    expect(provenance).toMatch(/RECORD_PATH = `\$\{RECORD_DIR\}\/backup-provenance`/);
    expect(check).toMatch(/RECORD_FILE="\$\{2:-\/var\/lib\/kajianq\/backup-provenance\}"/);
    expect(provenance).not.toMatch(/RECORD_DIR = "\/srv\/kajianq/);
    expect(backup).toMatch(
      /import \{ RECORD_PATH, recordBody, writeRecordFile \} from "\.\/provenance\.mjs"/,
    );
    // The job writes the file 0644, so the deploy identity can read a proof it cannot write;
    // the root-owned 0755 directory is the host configuration's half of that contract.
    expect(provenance).toMatch(/writeFileSync\(tmp, body, \{ mode: 0o644 \}\)/);
    // The unit's ExecStartPre marker is a host file installed by ahaqqu/vps; it writes that
    // same record path, so the preflight reads the pre-body state rather than the previous
    // success.
  });

  it("makes the production record directory world-traversable (mutation: drop the production chmod)", () => {
    // The record directory's 0755 is the half of the permission contract the writer itself
    // supplies; without it the deploy identity cannot stat/read the record under a stricter
    // umask. A --record directory is left alone: widening /tmp or a fixture would be a bug.
    const dir = mkdtempSync(join(tmpdir(), "kajianq-record-dir-"));
    const caller = mkdtempSync(join(tmpdir(), "kajianq-record-caller-"));
    try {
      chmodSync(dir, 0o700);
      chmodSync(caller, 0o700);
      ensureRecordDir(dir, dir);
      ensureRecordDir(caller, dir);
      expect(statSync(dir).mode & 0o777).toBe(0o755);
      expect(statSync(caller).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(caller, { recursive: true, force: true });
    }
  });

  it("the deploy runs the provenance preflight before it builds, ships or restarts anything", () => {
    // Read-only and independent of the shipped tree, so it can — and must — fail before the
    // first mutation: after the ship, the same red leaves the new tree live, the API restarted
    // and the smoke and doctor skipped.
    const script = read("provision/vps/deploy/deploy.sh");
    const preflight = script.indexOf("backup-provenance.sh");
    expect(preflight).toBeGreaterThan(-1);
    // Shipped as a file piped into `bash -s`, not quoted into the remote command, so the file
    // the tests execute is the file that runs on the box.
    expect(script).toMatch(
      /bash -s[\s\S]{0,40}<"\$\{REPO_DIR\}\/provision\/vps\/deploy\/backup-provenance\.sh"/,
    );
    for (const mutation of [
      "bun run build:web",
      "tar -czf",
      "rsync -a --partial",
      "sudo -n /usr/local/sbin/vps-deploy kajianq",
      "sudo ${SYSTEMCTL} start kajianq-cron.service",
    ]) {
      const at = script.indexOf(mutation);
      expect(at, `deploy.sh must still contain: ${mutation}`).toBeGreaterThan(-1);
      expect(preflight, `the provenance preflight must precede ${mutation}`).toBeLessThan(at);
    }
  });

  it("the backup job ships as a deployed artifact, not from the repository checkout", () => {
    // The unit must run a DEPLOYED artifact, not a path in the repository checkout: production
    // otherwise ran whatever revision sat in that checkout, which the deploy never updated.
    // Building a third bundle beside index.js/cleanup.js puts it under the deploy's control.
    const script = read("provision/vps/deploy/deploy.sh");
    expect(script).toMatch(
      /bun build "\$\{REPO_DIR\}\/provision\/vps\/backup\/kajianq-backup\.mjs" --target=bun/,
    );
    expect(script).toMatch(/--outfile "\$\{STAGE\}\/api\/backup\.js"/);
  });

  it("the backup script's provenance probe cannot abort a run", () => {
    // Provenance must go through a probe that returns rather than exits: this script's `fail()`
    // calls process.exit(1), and an exit is not an exception a try/catch can contain.
    const script = read("provision/vps/backup/kajianq-backup.mjs");
    expect(script).toMatch(/function probe\(cmd, args, opts = \{\}\)/);
    expect(script).toMatch(/sha: probe\("git", \["rev-parse", "HEAD"\]/);
    // `gitInfo` must not use `run()` — that is the fatal path.
    const gitInfo = /function gitInfo\(\) \{[\s\S]*?\n\}/.exec(script)?.[0];
    expect(gitInfo, "kajianq-backup.mjs must define gitInfo()").toBeTruthy();
    expect(gitInfo).not.toMatch(/\brun\(/);
    // The probe itself must never call fail()/exit.
    const probeBody = /function probe\(cmd, args, opts = \{\}\) \{[\s\S]*?\n\}/.exec(script)?.[0];
    expect(probeBody).toBeTruthy();
    expect(probeBody).not.toMatch(/fail\(|process\.exit/);
  });

  it("the deploy env example carries placeholders, not a real host", () => {
    const example = read("provision/vps/deploy/deploy.env.example");
    expect(example).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(example).toMatch(/KAJIANQ_DEPLOY_HOST=/);
    expect(example).toMatch(/KAJIANQ_PUBLIC_URL=/);
  });

  it("the deploy's privileged calls are the helper and the cron proof, nothing else", () => {
    // The deploy's privileged half is sudo over ssh, where a missing grant fails as "a password
    // is required" — naming neither the rule nor the command. The grant lives with the host
    // configuration in ahaqqu/vps, so this test pins the set of commands deploy.sh may ask for:
    // a new privileged call must land in that repository's grant before it lands here.
    const script = read("provision/vps/deploy/deploy.sh");

    // Extract the sudo'd argv from the script's remote commands. The `sudo ` may follow a shell
    // quote, so quotes and whitespace are normalized first, `${SYSTEMCTL}` is resolved to the
    // literal the grant carries, and `-n` is skipped because sudoers matches the command after
    // it. The capture runs to the next shell separator, so an argument-bearing call is compared
    // in full.
    const resolved = script
      .replace(/\$\{SYSTEMCTL\}/g, "/usr/bin/systemctl")
      .replace(/["']/g, "\n");
    const used = [
      ...resolved.matchAll(
        /sudo\s+(?:-n\s+)?((?:\/usr\/local\/sbin\/vps-deploy|\/usr\/bin\/systemctl)\s+[^\n;|&]+)/g,
      ),
    ].map((m) => m[1].trim());
    expect([...new Set(used)].sort()).toEqual([
      "/usr/bin/systemctl start kajianq-cron.service",
      "/usr/local/sbin/vps-deploy kajianq",
    ]);
    // The helper owns the restart and its health wait; a raw restart here would fight the
    // contract's rollback, and the diagnostics belong to the doctor the identity runs.
    expect(resolved).not.toMatch(/sudo\s+(?:-n\s+)?\/usr\/bin\/systemctl\s+restart/);
    expect(resolved).not.toMatch(/sudo[^\n]*(nginx -t|certbot certificates)/);
  });

  it("ships one tar artifact and asks the helper to swap it, never writing the target", () => {
    const script = read("provision/vps/deploy/deploy.sh");
    // Both trees are archived at the root, so the helper's tar-table check sees exactly
    // api/… and web/…. The archive sits beside them and the tar names only those two trees,
    // so it cannot include itself.
    expect(script).toMatch(/tar -czf "\$\{STAGE\}\/kajianq\.tar\.gz" -C "\$\{STAGE\}" api web/);
    // The helper does not restore member readability; the staged tree is normalized before
    // the tar, so a build under a stricter umask cannot ship a bundle nobody can read.
    expect(script).toMatch(
      /find "\$\{STAGE\}\/api" "\$\{STAGE\}\/web" -type d -exec chmod 0755 \{\} \+/,
    );
    expect(script).toMatch(
      /find "\$\{STAGE\}\/api" "\$\{STAGE\}\/web" -type f -exec chmod 0644 \{\} \+/,
    );
    expect(script.indexOf('find "${STAGE}/api"')).toBeLessThan(script.indexOf("tar -czf"));
    // Uploaded to the contract's fixed incoming path; the helper verifies its owner and caps.
    expect(script).toMatch(/-a --partial[\s\S]{0,160}\/srv\/vps-incoming\/kajianq\.tar\.gz/);
    // The helper is the only writer of the live tree.
    expect(script).toMatch(/sudo -n \/usr\/local\/sbin\/vps-deploy kajianq/);
    // No rsync or mkdir may reach the target tree again, and the raw restart and its
    // is-active probe moved into the helper.
    expect(script).not.toMatch(/rsync[^\n]*\$\{DEPLOY_ROOT\}/);
    expect(script).not.toMatch(/rsync[^\n]*\/srv\/kajianq/);
    expect(script).not.toMatch(/mkdir -p[^\n]*DEPLOY_ROOT/);
    expect(script).not.toMatch(/sudo[^\n]*restart kajianq-api\.service/);
    expect(script).not.toMatch(/is-active --quiet/);
  });

  it("a markdown link gate exists and is wired into CI", () => {
    // Nothing else in CI notices a dangling doc link, and GitHub renders one as ordinary text,
    // so a reader cannot tell they are looking at a broken citation.
    const script = read("scripts/check-markdown-links.mjs");
    expect(script).toMatch(/markdown-links/);
    // It must resolve relative targets, not merely look for the string.
    expect(script).toMatch(/existsSync/);
    // Fenced code blocks carry link syntax as examples, so scanning them would false-positive.
    expect(script).toMatch(/inFence/);
    // Vendored READMEs are not this repo's prose.
    expect(script).toMatch(/node_modules/);
    expect(read("package.json")).toMatch(/"docs:links":/);
    expect(read(".github/workflows/ci.yml")).toMatch(/bun run docs:links/);
  });
});

describe("the deploy's migration preflight", () => {
  const read = (rel) => readFileSync(resolve(process.cwd(), rel), "utf8");
  const deployScript = "provision/vps/deploy/deploy.sh";

  it("refuses a pending migration, naming it and the exact db:up command", async () => {
    // The failure this exists for is silent: the new build answers 503 on the admin
    // routes and the smoke never touches them, so a green deploy would hide it.
    const fixture = migrationFixture();
    try {
      const port = await freePort();
      fixture.writeStatus(migrationStatus({ pending: ["0003_admin_session_revocations.sql"] }));
      const result = fixture.run([], {
        DATABASE_URL: `postgres://kajianq:secret@127.0.0.1:${port}/kajianq`,
        KAJIANQ_DB_TUNNEL_TARGET: "kajianq-deploy@example.test",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/pending migrations: 0003_admin_session_revocations\.sql/);
      // The exact command for the set the file belongs to — not the other two sets.
      expect(result.stderr.split("\n").filter((line) => line.includes("bun run db:up"))).toEqual([
        "deploy:   bun run db:up:api",
      ]);
      // The one short-lived tunnel is closed on the refusal path too.
      expect(existsSync(fixture.cleaned)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("proceeds when the ledger is clean and closes its tunnel", async () => {
    const fixture = migrationFixture();
    try {
      const port = await freePort();
      fixture.writeStatus(migrationStatus());
      const result = fixture.run([], {
        DATABASE_URL: `postgres://kajianq:secret@127.0.0.1:${port}/kajianq`,
        KAJIANQ_DB_TUNNEL_TARGET: "kajianq-deploy@example.test",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/no pending migrations/);
      expect(existsSync(fixture.cleaned)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses a port a foreign listener already holds instead of reading its ledger", async () => {
    // The readiness probe cannot tell this script's forward from any other
    // listener: with a foreign server on the port and an ssh whose forward fails
    // to bind, the probe succeeds against the foreign server and a clean-looking
    // report would be read as "no pending migrations" while this deploy's tunnel
    // never came up. The port must therefore be free before ssh is spawned; the
    // status command must never run.
    const fixture = migrationFixture();
    const port = await freePort();
    const foreign = createServer(() => {});
    await new Promise((resolveListen) => foreign.listen(port, "127.0.0.1", resolveListen));
    try {
      // A clean ledger is the false green this test exists to rule out.
      fixture.writeStatus(migrationStatus());
      for (const mode of [undefined, "fail"]) {
        const result = fixture.run([], {
          DATABASE_URL: `postgres://kajianq:secret@127.0.0.1:${port}/kajianq`,
          KAJIANQ_DB_TUNNEL_TARGET: "kajianq-deploy@example.test",
          ...(mode ? { STUB_SSH_MODE: mode } : {}),
        });
        expect(result.status, `mode ${mode}`).toBe(1);
        expect(result.stdout, `mode ${mode}`).not.toMatch(/no pending migrations/);
        expect(result.stderr, `mode ${mode}`).toMatch(/already bound/);
        // The refusal precedes the spawn and the ledger read: neither stub ran.
        expect(existsSync(fixture.sshArgv), `mode ${mode}`).toBe(false);
        expect(existsSync(fixture.statusRan), `mode ${mode}`).toBe(false);
      }
    } finally {
      await new Promise((resolveClose) => foreign.close(resolveClose));
      fixture.cleanup();
    }
  });

  it("refuses a status report it cannot read instead of reading it as clean", () => {
    // A producer-side format change must red this gate, not silently turn "the
    // pending lines are gone" into "no pending migrations" and exit 0. The
    // shapes below cover the human listing, an object without pending, a
    // non-string pending list, and no report at all.
    const fixture = migrationFixture();
    try {
      const dsn = "postgres://kajianq:secret@127.0.0.1:25432/kajianq";
      for (const [shape, report] of [
        [
          "the pre-JSON text format",
          ["applied   0001_init.sql", "pending   0003_feedback_dedup.sql"],
        ],
        ["an object without pending", ['{"applied":["0001_init.sql"]}']],
        ["a non-string pending list", ['{"applied":[],"pending":[3]}']],
        ["no report at all", []],
      ]) {
        fixture.writeStatus(report);
        const result = fixture.run([], { DATABASE_URL: dsn, KAJIANQ_DB_TUNNEL_TARGET: "" });
        expect(result.status, shape).toBe(1);
        expect(result.stdout, shape).not.toMatch(/no pending migrations/);
        expect(result.stderr, shape).toMatch(/refusing to read/);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses a ledger report that covers only some of the migration sets", () => {
    // A chain that stopped after one set still prints a clean report: that is a
    // narrowed ledger, not a clean one. The report below is the engine set with
    // every migration applied, i.e. exactly what a one-set chain would print.
    const fixture = migrationFixture();
    try {
      const [engine] = MIGRATION_SETS;
      fixture.writeStatus(statusLines(engine, new Set(engine), { json: true }));
      const result = fixture.run([], {
        DATABASE_URL: "postgres://kajianq:secret@127.0.0.1:25432/kajianq",
        KAJIANQ_DB_TUNNEL_TARGET: "",
      });
      expect(result.status).toBe(1);
      expect(result.stdout).not.toMatch(/no pending migrations/);
      expect(result.stderr).toMatch(/reported 1 of 3 migration sets/);
      expect(result.stderr).toMatch(/missing: domain product/);
    } finally {
      fixture.cleanup();
    }
  });

  it("names every pending migration and each set's command when two sets are behind", async () => {
    const fixture = migrationFixture();
    try {
      const port = await freePort();
      fixture.writeStatus(
        migrationStatus({
          pending: ["0002_eval_results_question_id_text.sql", "0003_admin_session_revocations.sql"],
        }),
      );
      const result = fixture.run([], {
        DATABASE_URL: `postgres://kajianq:secret@127.0.0.1:${port}/kajianq`,
        KAJIANQ_DB_TUNNEL_TARGET: "kajianq-deploy@example.test",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /pending migrations: 0002_eval_results_question_id_text\.sql 0003_admin_session_revocations\.sql/,
      );
      expect(result.stderr.split("\n").filter((line) => line.includes("bun run db:up"))).toEqual([
        "deploy:   bun run db:up",
        "deploy:   bun run db:up:api",
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when DATABASE_URL is missing, naming it and the one explicit escape", () => {
    const fixture = migrationFixture();
    try {
      const result = fixture.run([], { DATABASE_URL: "" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/DATABASE_URL is not set/);
      expect(result.stderr).toMatch(/--skip-migration-check/);
      // The refusal is the first thing: no tunnel and no status command ran.
      expect(existsSync(fixture.cleaned)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when the status command cannot run", async () => {
    // A partial ledger read is not a clean one: db:status:all:json stops at the
    // first failing set, and the deploy must not read that as "nothing pending".
    const fixture = migrationFixture();
    try {
      const port = await freePort();
      fixture.writeStatus(migrationStatus({ pending: ["0003_admin_session_revocations.sql"] }));
      const result = fixture.run([], {
        DATABASE_URL: `postgres://kajianq:secret@127.0.0.1:${port}/kajianq`,
        KAJIANQ_DB_TUNNEL_TARGET: "kajianq-deploy@example.test",
        STUB_STATUS_EXIT: "1",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/bun run db:status:all:json exited 1/);
      expect(result.stderr).toMatch(/--skip-migration-check/);
      // The tunnel is up before the failing read, and closed after the refusal.
      expect(existsSync(fixture.ready)).toBe(true);
      expect(existsSync(fixture.cleaned)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when the tunnel does not come up", async () => {
    const fixture = migrationFixture();
    try {
      const port = await freePort();
      fixture.writeStatus(migrationStatus());
      const result = fixture.run([], {
        DATABASE_URL: `postgres://kajianq:secret@127.0.0.1:${port}/kajianq`,
        KAJIANQ_DB_TUNNEL_TARGET: "kajianq-deploy@example.test",
        STUB_SSH_MODE: "fail",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/could not open the database tunnel/);
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses a tunnel that dies between the readiness probe and the ledger read", async () => {
    // The readiness probe proves the forward answered once; ssh can still exit
    // before the ledger is read, and reading through the now-free port would
    // reach whatever listener took it. The BASH_ENV shim holds the first
    // `kill -0` until the stub is listening (so the probe succeeds), then
    // reports the tunnel dead on the re-check.
    const fixture = migrationFixture();
    try {
      const port = await freePort();
      fixture.writeStatus(migrationStatus());
      const result = fixture.run([], {
        DATABASE_URL: `postgres://kajianq:secret@127.0.0.1:${port}/kajianq`,
        KAJIANQ_DB_TUNNEL_TARGET: "kajianq-deploy@example.test",
        BASH_ENV: fixture.killAfterReady,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/exited before the ledger was read/);
      expect(result.stdout).not.toMatch(/no pending migrations/);
      // The probe saw a live tunnel, the status command never ran, and the
      // refusal closed the tunnel.
      expect(existsSync(fixture.ready)).toBe(true);
      expect(existsSync(fixture.statusRan)).toBe(false);
      expect(existsSync(fixture.cleaned)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps the DSN and its password off both streams on every refusal path", async () => {
    // The DSN must never reach argv or either stream: the check reads the
    // password from the environment, and a refusal that echoed the URL would
    // write it to the deploy log. The canary is in the password, so one leak on
    // any refusal path reddens here; the ssh argv assertion pins the forward to
    // the tunnel's port. The cases below drive every refusal the script has.
    const canary = "CANARY-CREDENTIAL";
    const fixture = migrationFixture();
    try {
      const port = await freePort();
      const dsn = `postgres://kajianq:${canary}@127.0.0.1:${port}/kajianq`;
      const target = "kajianq-deploy@example.test";
      const run = (path, extra = {}, args = []) => {
        const result = fixture.run(args, {
          DATABASE_URL: dsn,
          KAJIANQ_DB_TUNNEL_TARGET: target,
          ...extra,
        });
        expect(result.status, path).toBe(1);
        expect(result.stdout, path).not.toContain(canary);
        expect(result.stderr, path).not.toContain(canary);
      };

      // A pending migration.
      fixture.writeStatus(migrationStatus({ pending: ["0003_admin_session_revocations.sql"] }));
      run("pending migration");
      // An unknown argument, refused before the DSN is parsed.
      run("unknown argument", {}, ["--bogus"]);
      // The status command fails.
      run("status failure", { STUB_STATUS_EXIT: "1" });
      // The tunnel never comes up.
      run("tunnel failure", { STUB_SSH_MODE: "fail" });
      // The tunnel dies after the readiness probe.
      rmSync(fixture.ready, { force: true });
      run("tunnel died before the ledger read", { BASH_ENV: fixture.killAfterReady });
      // DSN shapes refused before ssh is spawned.
      run("non-postgres URL", {
        DATABASE_URL: `mysql://kajianq:${canary}@127.0.0.1:${port}/kajianq`,
      });
      run("non-loopback host", {
        DATABASE_URL: `postgres://kajianq:${canary}@db.example.test:${port}/kajianq`,
      });
      run("DSN without a port", {
        DATABASE_URL: `postgres://kajianq:${canary}@127.0.0.1/kajianq`,
      });
      run("non-numeric port", {
        DATABASE_URL: `postgres://kajianq:${canary}@127.0.0.1:not-a-port/kajianq`,
      });
      run("missing DSN", { DATABASE_URL: "" });
      // A port a foreign listener already holds.
      const occupied = await freePort();
      const foreign = createServer(() => {});
      await new Promise((resolveListen) => foreign.listen(occupied, "127.0.0.1", resolveListen));
      try {
        run("port already bound", {
          DATABASE_URL: `postgres://kajianq:${canary}@127.0.0.1:${occupied}/kajianq`,
        });
      } finally {
        await new Promise((resolveClose) => foreign.close(resolveClose));
      }
      // Reports the parser refuses.
      fixture.writeStatus(['{"applied":["0001_init.sql"]}']);
      run("unrecognised report", { KAJIANQ_DB_TUNNEL_TARGET: "" });
      fixture.writeStatus(['{"applied":[],"pending":[3]}']);
      run("non-string pending list", { KAJIANQ_DB_TUNNEL_TARGET: "" });
      fixture.writeStatus(['{"applied":["0001_unknown.sql"],"pending":[]}']);
      run("report naming no set", { KAJIANQ_DB_TUNNEL_TARGET: "" });
      fixture.writeStatus(['{"applied":["0001_init.sql"],"pending":["0001_product.sql"]}']);
      run("report mixing sets", { KAJIANQ_DB_TUNNEL_TARGET: "" });
      fixture.writeStatus(['{"applied":[],"pending":[]}']);
      run("report with no migration names", { KAJIANQ_DB_TUNNEL_TARGET: "" });
      const [engine] = MIGRATION_SETS;
      fixture.writeStatus(statusLines(engine, new Set(engine), { json: true }));
      run("report missing migration sets", { KAJIANQ_DB_TUNNEL_TARGET: "" });
      fixture.writeStatus([]);
      run("no report", { KAJIANQ_DB_TUNNEL_TARGET: "" });
      // The forward ssh is handed carries the tunnel's port only.
      const argv = readFileSync(fixture.sshArgv, "utf8");
      expect(argv).toContain(`-L 127.0.0.1:${port}:127.0.0.1:5432 ${target}`);
      expect(argv).not.toContain(canary);
      expect(argv).not.toMatch(/postgres/);
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses a DSN that names a host other than loopback", () => {
    // The tunnel is what carries the check; a DSN naming another host would make
    // the preflight read a database the deploy does not touch, so it must refuse.
    const fixture = migrationFixture();
    try {
      const result = fixture.run([], {
        DATABASE_URL: "postgres://kajianq:secret@db.example.test:15433/kajianq",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/must name a loopback host/);
      const noPort = fixture.run([], {
        DATABASE_URL: "postgres://kajianq:secret@127.0.0.1/kajianq",
      });
      expect(noPort.status).toBe(1);
      expect(noPort.stderr).toMatch(/names no port/);
    } finally {
      fixture.cleanup();
    }
  });

  it("honours --skip-migration-check only as the exact flag, never an environment variable", () => {
    const fixture = migrationFixture();
    try {
      const skipped = fixture.run(["--skip-migration-check"], { DATABASE_URL: "" });
      expect(skipped.status).toBe(0);
      expect(skipped.stderr).toMatch(/WARNING: --skip-migration-check/);
      // An ambient variable with the flag's name must not be a second escape hatch.
      const ambient = fixture.run([], { DATABASE_URL: "", KAJIANQ_SKIP_MIGRATION_CHECK: "1" });
      expect(ambient.status).toBe(1);
      expect(ambient.stderr).toMatch(/DATABASE_URL is not set/);
      // A near miss must not silently skip either.
      const typo = fixture.run(["--skip"], { DATABASE_URL: "" });
      expect(typo.status).toBe(1);
      expect(typo.stderr).toMatch(/unknown argument/);
    } finally {
      fixture.cleanup();
    }
  });

  it("runs the preflight before the build, upload and helper lines in the deploy path", () => {
    const script = read(deployScript);
    const preflight = script.indexOf("migration-check.sh");
    expect(preflight).toBeGreaterThan(-1);
    for (const mutation of [
      "bun run build:web",
      "tar -czf",
      "rsync -a --partial",
      "sudo -n /usr/local/sbin/vps-deploy kajianq",
      "sudo ${SYSTEMCTL} start kajianq-cron.service",
    ]) {
      const at = script.indexOf(mutation);
      expect(at, `deploy.sh must still contain: ${mutation}`).toBeGreaterThan(-1);
      expect(preflight, `the migration preflight must precede ${mutation}`).toBeLessThan(at);
    }
  });

  it("composes db:status:all:json from exactly the three migration sets", () => {
    // The preflight requires one report per set, so the producer chain must read
    // all three: dropping a set would leave the deploy reading a narrowed
    // ledger. The engine set is the CLI's default directory; the other two pass
    // their directory explicitly.
    const scripts = JSON.parse(read("package.json")).scripts;
    expect(scripts["db:status:all:json"]).toBe(
      "bun run db:status:json && bun run db:status:domain:json && bun run db:status:api:json",
    );
    const setDirs = ["db:status:json", "db:status:domain:json", "db:status:api:json"].map(
      (name) => /--dir (\S+)$/.exec(scripts[name])?.[1] ?? "packages/infra/migrations",
    );
    expect(setDirs).toEqual([
      "packages/infra/migrations",
      "packages/kajianq-domain/migrations",
      "apps/api/migrations",
    ]);
    // Both sides of the report contract carry the same set list.
    const preflight = read("provision/vps/deploy/migration-check.sh");
    for (const dir of setDirs) {
      expect(preflight).toContain(`"${dir}"`);
    }
  });

  it("stops the real deploy path before it plans a build when a migration is pending", async () => {
    // deploy.sh --dry-run still runs this read-only preflight, so the assertion is
    // that the refusal precedes the first `would:` line: a real run cannot reach
    // the build, the ship or the restart, and a dry run does not describe one.
    const fixture = migrationFixture();
    const envDir = mkdtempSync(join(tmpdir(), "kajianq-deploy-env-"));
    try {
      const port = await freePort();
      fixture.writeStatus(migrationStatus({ pending: ["0003_admin_session_revocations.sql"] }));
      const envFile = join(envDir, "deploy.env");
      writeFileSync(envFile, deployEnv({ port }));
      chmodSync(envFile, 0o600);
      const deploy = spawnSync(
        "/bin/bash",
        [resolve(process.cwd(), deployScript), "--env", envFile, "--dry-run", "--no-smoke"],
        // The tunnel stub runs inside this call: without a bound timeout and a
        // kill signal, a regression that leaks it would hang the suite.
        { encoding: "utf8", env: fixture.env({}), timeout: 15_000, killSignal: "SIGKILL" },
      );
      expect(deploy.status).toBe(1);
      expect(deploy.stderr).toMatch(/pending migrations:/);
      expect(deploy.stdout).not.toMatch(/would:/);
    } finally {
      rmSync(envDir, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it("lets the operator through only when deploy.sh is given --skip-migration-check", () => {
    const fixture = migrationFixture();
    const envDir = mkdtempSync(join(tmpdir(), "kajianq-deploy-env-"));
    try {
      const envFile = join(envDir, "deploy.env");
      writeFileSync(envFile, deployEnv({ databaseUrl: null }));
      chmodSync(envFile, 0o600);
      const args = [
        resolve(process.cwd(), deployScript),
        "--env",
        envFile,
        "--dry-run",
        "--no-smoke",
      ];
      const refused = spawnSync("/bin/bash", args, {
        encoding: "utf8",
        env: fixture.env({}),
        timeout: 15_000,
        killSignal: "SIGKILL",
      });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toMatch(/DATABASE_URL is not set/);
      expect(refused.stdout).not.toMatch(/would:/);

      const skipped = spawnSync("/bin/bash", [...args, "--skip-migration-check"], {
        encoding: "utf8",
        env: fixture.env({}),
        timeout: 15_000,
        killSignal: "SIGKILL",
      });
      expect(skipped.status).toBe(0);
      expect(skipped.stdout).toMatch(/would:/);
      expect(skipped.stderr).toMatch(/WARNING: --skip-migration-check/);
    } finally {
      rmSync(envDir, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it("carries the DSN into the deploy job and never lets a workflow skip this preflight", () => {
    const workflowDir = resolve(process.cwd(), ".github/workflows");
    for (const name of readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file))) {
      expect(
        readFileSync(join(workflowDir, name), "utf8"),
        `${name} must not skip the migration preflight`,
      ).not.toContain("--skip-migration-check");
    }
    const deploy = read(".github/workflows/deploy-vps.yml");
    // A reusable workflow sees only the secrets it declares; the dispatch path
    // reads the repository-level value directly.
    expect(deploy).toMatch(/STAGING_DATABASE_URL:\n\s+required: false/);
    // Both the named guard and the deploy step carry the value.
    expect(
      (deploy.match(/DATABASE_URL: \$\{\{ secrets\.STAGING_DATABASE_URL \}\}/g) ?? []).length,
    ).toBe(2);
    expect(deploy).toMatch(/secrets\.STAGING_DATABASE_URL is unset/);
    // Staging maps the name into the reusable job, as it already does for the key.
    expect(read(".github/workflows/staging.yml")).toMatch(
      /STAGING_DATABASE_URL: \$\{\{ secrets\.STAGING_DATABASE_URL \}\}/,
    );
  });
});

describe("small helpers", () => {
  it("hashes bytes as lowercase hex sha256", async () => {
    // Known vector: sha256("") .
    expect(await sha256Hex(new TextEncoder().encode(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("formats counts compactly and deterministically", () => {
    expect(formatCounts({ users: 1, sessions: 2 })).toBe("users=1 sessions=2");
  });
});
