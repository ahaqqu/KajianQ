import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

/** The text of a bash function, exactly as the script ships it. */
function bashFunction(rel, name) {
  const text = readFileSync(resolve(process.cwd(), rel), "utf8");
  const start = text.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${rel} does not define ${name}()`);
  const end = text.indexOf("\n}\n", start);
  if (end === -1) throw new Error(`${name}() in ${rel} is not closed at column 0`);
  return text.slice(start, end + 2);
}

/**
 * apply.sh's install_config() as shipped, driven against a fixture pair. The test's own user
 * and group stand in for root:root, because no test runs as root — and owner/group are part of
 * what the function compares, so they have to match on both sides of the fixture.
 */
function configInstallFixture() {
  const dir = mkdtempSync(join(tmpdir(), "kajianq-config-"));
  const owner = spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();
  const group = spawnSync("id", ["-gn"], { encoding: "utf8" }).stdout.trim();
  const src = join(dir, "kajianq-backup.service");
  const dst = join(dir, "installed.service");
  writeFileSync(src, "[Unit]\nDescription=fixture\n");
  const shim = `${bashFunction("provision/vps/apply.sh", "install_config")}
log() { printf 'log: %s\\n' "$*"; }
install_config "$@"`;
  return {
    dir,
    src,
    dst,
    run: (env = {}) =>
      spawnSync("/bin/bash", ["-c", shim, "probe", src, dst, owner, group, "644"], {
        encoding: "utf8",
        env: { ...process.env, DRY_RUN: "0", ...env },
      }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
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
    writeRecord: (fields = {}) => writeFileSync(record, provenanceRecord(fields)),
    run: ({ unitFile = unit, recordFile = record, exited, status, catFail = false } = {}) =>
      spawnSync(
        "/bin/bash",
        [resolve(process.cwd(), "provision/vps/deploy/backup-provenance.sh"), unitFile, recordFile],
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
 * The marker kajianq-backup.service's ExecStartPre writes, executed from the repository script
 * apply.sh installs at /usr/local/sbin/kajianq-backup-pending. A test cannot start a unit, so
 * this is the unit's half of the pre-body contract: the record the preflight reads is the record
 * the unit's own marker produced.
 *
 * A caller may stub `mv` through PATH to observe the rename: the stub logs its argv and
 * snapshots the destination before the real binary performs it.
 */
function runPendingMarker(recordFile, { stubDir, mvLog, mvBefore, realMv } = {}) {
  const env = { ...process.env };
  if (stubDir) env.PATH = `${stubDir}:${process.env.PATH}`;
  if (mvLog) env.MV_LOG = mvLog;
  if (mvBefore) env.MV_BEFORE = mvBefore;
  if (realMv) env.REAL_MV = realMv;
  return spawnSync(
    "/bin/sh",
    [resolve(process.cwd(), "provision/vps/backup/kajianq-backup-pending.sh"), recordFile],
    { encoding: "utf8", env },
  );
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
   * One residual assertion block in comparable form: `--` comment text is stripped
   * per line before the lines are joined (a comment runs to the end of its line, so
   * stripping after the join would let a commented-out predicate and a live one
   * normalise to the same text), then blank lines, leading/trailing whitespace and
   * the trailing statement terminator are dropped. Internal spacing and literals
   * stay verbatim.
   */
  const normalizeBlock = (block) =>
    block
      .split("\n")
      .map((line) => line.replace(/--.*$/, "").trim())
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

  it("ships the scratch target in the env template as a placeholder, never the live database", () => {
    // Config-as-code, like the api.env example: the template is committed, so its values can
    // only be placeholders, and a restore onto the database it names would be refused.
    const parsed = parseEnvFile(
      readFileSync(resolve(process.cwd(), "provision/vps/backup/backup.env.example"), "utf8"),
    );
    expect(parsed.RESTORE_TARGET_URL).toMatch(/^postgres:\/\/kajianq:CHANGE_ME@/);
    expect(isSameDatabase(parsed.RESTORE_TARGET_URL, parsed.PGDATABASE_URL)).toBe(false);
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

describe("provisioning config as code stays true to the ADR", () => {
  const read = (rel) => readFileSync(resolve(process.cwd(), rel), "utf8");

  /** Every file under a directory, recursively — for whole-tree scans. */
  const walkFiles = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walkFiles(path) : [path];
    });
  /** Drop comment lines before asserting directives, since a file may explain why a
   * directive is NOT used and a substring assertion would read that explanation as the
   * directive itself. */
  const directives = (rel) =>
    read(rel)
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

  it("the proxy access log records the client IP and nothing about the visitor beyond it", () => {
    const conf = directives("provision/vps/nginx/kajianq.conf");
    // The log format must carry $remote_addr (the IP is the declared data category in the
    // Art. 30 record)…
    expect(conf).toMatch(/log_format kajianq_access[^;]*\$remote_addr/);
    // …and must NOT widen it with device, navigation, or identity identifiers.
    expect(conf).not.toMatch(/\$http_user_agent/);
    expect(conf).not.toMatch(/\$http_referer/);
    // $remote_user is only ever populated by HTTP basic auth, which this server block never
    // enables — a username is not a declared data category, so the format must not carry it.
    expect(conf).not.toMatch(/\$remote_user/);
  });

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

  it("the backup schedule is config-as-code, installed and enabled by apply.sh", () => {
    // The retention policy is only real if the timer runs: the units must be shipped files.
    const service = directives("provision/vps/systemd/kajianq-backup.service");
    // Optional (`-`) on purpose: a required file that is missing fails the unit before the
    // first ExecStartPre, so the pending marker would be absent exactly when the missing file is
    // the failure. The job refuses the run itself instead, and the record carries status=1.
    expect(service).toContain("EnvironmentFile=-/etc/kajianq/backup.env");
    // ExecStart names a DEPLOYED artifact, not a path in the repository checkout: a unit
    // running code the deploy never updated can be wired to stale code, so assert the static
    // path and that NO placeholder token remains.
    expect(service).toMatch(/ExecStart=\/usr\/bin\/bun run \/srv\/kajianq\/api\/backup\.js/);
    expect(service).not.toMatch(/__KAJIANQ_/);
    expect(service).toMatch(/Type=oneshot/);
    // Credentials in the unit text would be world-readable in the journal.
    expect(service).not.toMatch(/RESTIC_|PGDATABASE_URL/);
    const timer = directives("provision/vps/systemd/kajianq-backup.timer");
    expect(timer).toMatch(/OnCalendar=.+/);
    expect(timer).toMatch(/Persistent=true/);
    expect(timer).toMatch(/WantedBy=timers.target/);
    const apply = readFileSync(resolve(process.cwd(), "provision/vps/apply.sh"), "utf8");
    expect(apply).toMatch(/kajianq-backup\.service/);
    expect(apply).toMatch(/kajianq-backup\.timer/);
    expect(apply).toMatch(/enable --now kajianq-backup\.timer/);
  });

  it("bounds a hung backup, so an interrupted start marker cannot last forever (mutation: no TimeoutStartSec)", () => {
    // Type=oneshot has no start timeout by default: a wedged run would keep the timer (and the
    // start marker) in place forever. The bound is what lets systemd kill it and a later run
    // replace the marker with a completed record.
    const service = directives("provision/vps/systemd/kajianq-backup.service");
    expect(service).toMatch(/^TimeoutStartSec=2h$/m);
  });

  it("every unit running with ProtectHome= executes a binary outside the home directories", () => {
    // ProtectHome hides /home and /root from the unit, so an ExecStart naming a
    // home-directory install fails for a binary that exists. Assert the property over the
    // shipped units rather than the prose that warns about it: a new unit that hides home and
    // then runs the runtime from one reddens here.
    const services = walkFiles("provision/vps/systemd").filter((f) => f.endsWith(".service"));
    expect(services.length).toBeGreaterThan(0);
    let guarded = 0;
    for (const file of services) {
      const unit = directives(file);
      if (!/^ProtectHome=(yes|true|read-only|tmpfs)$/m.test(unit)) continue;
      guarded++;
      const exec = /^ExecStart=(\S+)/m.exec(unit)?.[1];
      expect(exec, `${file}: ProtectHome= set without an absolute ExecStart`).toBeTruthy();
      expect(exec, `${file}: ProtectHome hides ${exec}`).not.toMatch(/^\/(home|root)(\/|$)/);
    }
    expect(guarded, "no unit sets ProtectHome= — the assertion would be vacuous").toBeGreaterThan(
      0,
    );
  });

  it("the provisioning SQL creates the role and database apply.sh deliberately does not", () => {
    // apply.sh installs the Postgres posture but creates no role or database, so the SQL the
    // operator pastes from the setup doc is the artifact that provisions them: assert its
    // statements, not the sentences around them. A block that lost LOGIN, the bound password
    // or OWNER would leave the API unable to start, and nothing else in CI would notice.
    expect(directives("provision/vps/apply.sh")).not.toMatch(
      /CREATE ROLE|createuser|CREATE DATABASE|createdb/,
    );
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

  it("render() substitutes every placeholder a shipped config may carry", () => {
    // Derived, not enumerated: every `__KAJIANQ_*__` token appearing in a shipped config
    // (anything under provision/vps/ except apply.sh itself) must have a matching sed entry in
    // apply.sh's render(), so a new placeholder fails this test until it is wired.
    const SRC = "provision/vps";
    const apply = readFileSync(resolve(process.cwd(), `${SRC}/apply.sh`), "utf8");
    const renderBody = /render\(\) \{[\s\S]*?\n\}/.exec(apply)?.[0];
    expect(renderBody, "apply.sh must define render()").toBeTruthy();

    const substituted = new Set(
      [...renderBody.matchAll(/__KAJIANQ_([A-Z_]+)__\|/g)].map((m) => m[1]),
    );
    expect(substituted.size).toBeGreaterThanOrEqual(4);

    const shipped = walkFiles(resolve(process.cwd(), SRC))
      .filter((path) => !path.endsWith("apply.sh"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    // matchAll, not a single exec: a line may carry MORE than one token, and taking only the
    // first per line would let a second one through unsubstituted.
    const declared = new Set([...shipped.matchAll(/__KAJIANQ_([A-Z_]+)__/g)].map((m) => m[1]));
    expect(declared.size).toBeGreaterThanOrEqual(4);

    for (const name of declared) {
      expect(
        substituted.has(name),
        `render() in apply.sh does not substitute __KAJIANQ_${name}__, so a config shipping it installs the literal token`,
      ).toBe(true);
    }
  });

  it("render() refuses to install a config that still carries a placeholder token", () => {
    // The substitution list is one mechanism; this is the backstop that makes a future omission
    // loud at apply time, and it must abort the whole apply rather than half-apply a config.
    const apply = readFileSync(resolve(process.cwd(), "provision/vps/apply.sh"), "utf8");
    const renderBody = /render\(\) \{[\s\S]*?\n\}/.exec(apply)?.[0];
    expect(renderBody).toMatch(/grep -qE '__KAJIANQ_\[A-Z_\]\+__'/);
    expect(renderBody).toMatch(/exit 1/);
    // It must run BEFORE the install, or the broken file is already in place when it fires.
    expect(renderBody.search(/grep -qE '__KAJIANQ_\[A-Z_\]\+__'/)).toBeLessThan(
      renderBody.indexOf("install_config"),
    );
  });

  it("apply.sh refuses to source an env file that is not root-owned 0600-or-tighter", () => {
    // The env file is executed with root privileges; a writable one is local privilege escalation.
    const apply = readFileSync(resolve(process.cwd(), "provision/vps/apply.sh"), "utf8");
    expect(apply).toMatch(/stat -c '%U:%G' "\$\{ENV_FILE\}"/);
    expect(apply).toMatch(/!= "root:root"/);
    expect(apply).toMatch(/& 077\)\)" -ne 0/);
    // The check must precede the source.
    expect(apply.indexOf("root:root")).toBeLessThan(apply.indexOf('. "${ENV_FILE}"'));
  });

  it("the proxy establishes CF-Connecting-IP from $remote_addr, so the rate limiter cannot be spoofed", () => {
    // apps/api/src/lib/middleware.ts reads CF-Connecting-IP: if nginx passed the client's own
    // header through, a caller could mint a fresh limiter key per request.
    const conf = directives("provision/vps/nginx/kajianq.conf");
    expect(conf).toMatch(/proxy_set_header CF-Connecting-IP\s+\$remote_addr/);
  });

  it("HTTP only redirects and logs nothing, so the IP-bearing log is confined to the TLS server block", () => {
    const conf = directives("provision/vps/nginx/kajianq.conf");
    const plain = conf.slice(conf.indexOf("listen 80"));
    expect(plain).toMatch(/access_log off/);
    expect(plain).not.toContain("kajianq_access");
  });

  it("every shipped config uses placeholders, never a real hostname or certificate path", () => {
    for (const file of [
      "provision/vps/nginx/kajianq.conf",
      "provision/vps/systemd/kajianq-api.service",
      "provision/vps/systemd/kajianq-backup.service",
      "provision/vps/postgres/99-kajianq.conf",
    ]) {
      const text = read(file);
      // Hostnames/IPs/certs are placeholders the apply script substitutes.
      expect(text, file).not.toMatch(/https?:\/\/[a-z0-9.-]+\.(com|net|org|dev|id)/);
      expect(text, file).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    }
  });

  it("the proxy logrotate policy enforces the ADR's 14-day window with a size cap", () => {
    const conf = directives("provision/vps/logrotate/kajianq-proxy");
    // rotate 13 + daily: current day + 13 rotated = 14 calendar days, the value the ADR and
    // the Art. 30 record declare (a `rotate 14` would keep a 15th day).
    expect(conf).toMatch(/rotate 13\b/);
    expect(conf).not.toMatch(/rotate 14\b/);
    expect(conf).toMatch(/daily/);
    expect(conf).toMatch(/maxsize/);
    // nginx reopens its logs on SIGUSR1; copytruncate would be the wrong tool.
    expect(conf).toContain("kill -USR1");
    expect(conf).not.toContain("copytruncate");
    // The error log is IP-bearing too, so it must be in the same stanza.
    expect(conf).toContain("/var/log/nginx/kajianq.error.log");
  });

  it("the Postgres logrotate policy rotates and truncates in place, since Postgres never reopens", () => {
    const conf = directives("provision/vps/logrotate/kajianq-postgres");
    // Same arithmetic as the proxy stanza: 14 calendar days in total.
    expect(conf).toMatch(/rotate 13\b/);
    expect(conf).not.toMatch(/rotate 14\b/);
    expect(conf).toContain("copytruncate");
    expect(conf).toContain("/var/log/postgresql/*.log");
  });

  it("Postgres never logs statement text, so a chat question cannot land in an ops log", () => {
    const conf = directives("provision/vps/postgres/99-kajianq.conf");
    expect(conf).toMatch(/log_statement = 'none'/);
    expect(conf).toMatch(/listen_addresses = 'localhost'/);
  });

  it("the API journald cap is bounded in both bytes and time", () => {
    const conf = directives("provision/vps/journald/kajianq.conf");
    expect(conf).toMatch(/SystemMaxUse=\d+[MG]/);
    expect(conf).toMatch(/MaxRetentionSec=14d/);
    expect(conf).toMatch(/Storage=persistent/);
  });

  it("the API systemd unit reads its credentials from a file, never from the unit text", () => {
    const unit = directives("provision/vps/systemd/kajianq-api.service");
    expect(unit).toContain("EnvironmentFile=/etc/kajianq/api.env");
    // A DATABASE_URL inline in the unit would be readable in the process table and the journal.
    expect(unit).not.toMatch(/DATABASE_URL=/);
    expect(unit).toContain("NoNewPrivileges=yes");
  });

  it("the served entry the unit runs is the Bun one, with no Cloudflare runtime left", () => {
    // ExecStart must name the Bun entry point built from apps/api/src/boot.ts, not a Worker
    // artifact (ADR-0044 decision 1).
    const unit = directives("provision/vps/systemd/kajianq-api.service");
    expect(unit).toMatch(/ExecStart=\/usr\/bin\/bun run \/srv\/kajianq\/api\/index\.js/);
    expect(unit).toContain("User=kajianq");
    // A workerd / alchemy deployment path is gone, so nothing in the unit may reference it.
    expect(unit).not.toMatch(/workerd|alchemy|wrangler/i);
  });

  it("the SIGTERM drain ceiling matches the code's drain deadline, not systemd's 90 s default", () => {
    // The drain (boot.ts waits for in-flight SSE answers up to DRAIN_TIMEOUT_MS) is only real if
    // the unit lets it run: TimeoutStopSec must equal the code's deadline — smaller SIGKILLs a
    // healthy drain, larger waits past the stream nginx has already cut.
    const unit = directives("provision/vps/systemd/kajianq-api.service");
    expect(unit).toContain("TimeoutStopSec=300s");
    expect(unit).toContain("KillMode=mixed");
    const server = readFileSync(resolve(process.cwd(), "apps/api/src/lib/server.ts"), "utf8");
    expect(server).toMatch(/DRAIN_TIMEOUT_MS = 300_000/);
    const nginx = directives("provision/vps/nginx/kajianq.conf");
    expect(nginx).toContain("proxy_read_timeout 300s");
  });

  it("the session reclaim runs as its own timer at ADR-0017's 03:17 slot", () => {
    // The reclamation must be independently observable, not an in-process interval.
    const service = directives("provision/vps/systemd/kajianq-cron.service");
    expect(service).toMatch(/Type=oneshot/);
    expect(service).toContain("EnvironmentFile=/etc/kajianq/api.env");
    expect(service).toMatch(/ExecStart=\/usr\/bin\/bun run \/srv\/kajianq\/api\/cleanup\.js/);
    expect(service).toContain("User=kajianq");
    // Credentials in the unit text would be world-readable in the journal.
    expect(service).not.toMatch(/DATABASE_URL=/);
    const timer = directives("provision/vps/systemd/kajianq-cron.timer");
    expect(timer).toMatch(/OnCalendar=\*-\*-\* 03:17:00/);
    expect(timer).toMatch(/Persistent=true/);
    expect(timer).toContain("Unit=kajianq-cron.service");
    expect(timer).toMatch(/WantedBy=timers.target/);
    const apply = readFileSync(resolve(process.cwd(), "provision/vps/apply.sh"), "utf8");
    expect(apply).toMatch(/kajianq-cron\.service/);
    expect(apply).toMatch(/systemctl enable kajianq-cron\.timer/);
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

  it("the deploy requires KAJIANQ_DEPLOY_ROOT and has no tree to fall back to", () => {
    // The tree decides what a deploy replaces, so both halves are pinned: the name is in the
    // required-name gate, and the assignment carries no `:-` default. Reverting both halves
    // would let an operator env file that omits the tree ship to /srv/kajianq while reporting
    // success; each half alone still fails — the loop by name, the expansion as an unbound
    // variable under `set -u`.
    const script = read("provision/vps/deploy/deploy.sh");
    const required = /for var in ([^;]+); do/.exec(script)?.[1];
    expect(required, "deploy.sh must keep its required-name loop").toBeTruthy();
    expect(required.split(/\s+/)).toContain("KAJIANQ_DEPLOY_ROOT");
    expect(script).toMatch(/^DEPLOY_ROOT="\$\{KAJIANQ_DEPLOY_ROOT\}"$/m);
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

  it("apply.sh installs the backup unit through the write-if-changed helper", () => {
    // The deploy reads this unit's mtime, so a plain `install` here — which re-stamps a file
    // even when the bytes are identical — is the regression that marks an exercised unit as
    // never exercised and fails the next deploy.
    const apply = read("provision/vps/apply.sh");
    // The unit is one row of apply.sh's artifact table; the install dispatcher
    // routes that row's `config` kind through install_config.
    expect(apply).toMatch(
      /^backup-unit\|config\|systemd\/kajianq-backup\.service\|\/etc\/systemd\/system\/kajianq-backup\.service\|root\|root\|644$/m,
    );
    expect(apply).toMatch(/install_artifact backup-unit/);
    expect(apply).toMatch(
      /config\) install_config "\$\{src\}" "\$\{dst\}" "\$\{owner\}" "\$\{group\}" "\$\{mode\}"/,
    );
    expect(apply).not.toMatch(
      /install -o root -g root -m 0644 "\$\{SRC\}\/systemd\/kajianq-backup\.service"/,
    );
    // Not just that unit: no raw `install` may write a file anywhere in the script, since
    // every config it places has an mtime a future check could read and `install` re-stamps an
    // identical file. Pinning one spelling would only catch one spelling — `-m0644`,
    // `--mode=0644`, `--owner=root --group=root`, `install -m 0644 -o root -g root` all slip
    // past a substring match — so the rule is an allowlist over the INVOCATIONS: the raw
    // invocations that exist are the `install -d` directory creations (directories hold no
    // content), the helper's own write, and the visudo-gated sudoers grant, which is staged at
    // 0440 and moved into place by a parse-gated `mv`. A new invocation anywhere reddens here,
    // whatever its flags.
    const invocations = apply
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^(run )?install\b/.test(line))
      .map((line) => line.replace(/\s+/g, " "));
    expect(invocations.length).toBeGreaterThanOrEqual(6);
    const allowed = [
      /^(run )?install -d /,
      /^install -o "\$\{owner\}" -g "\$\{group\}" -m "\$\{mode\}"/,
    ];
    for (const invocation of invocations) {
      expect(
        allowed.some((pattern) => pattern.test(invocation)),
        `raw install in apply.sh — route it through install_config: ${invocation}`,
      ).toBe(true);
    }
  });

  it("threads the table's owner, group and mode through render and the sudoers install", () => {
    // The table is the one place a row's ownership and mode are decided. A helper
    // that hard-codes them would install one thing and have the drift check demand
    // another the moment a row changes.
    const apply = read("provision/vps/apply.sh");
    expect(apply).toMatch(
      /render\) render "\$\{src\}" "\$\{dst\}" "\$\{owner\}" "\$\{group\}" "\$\{mode\}"/,
    );
    expect(apply).toMatch(
      /sudoers\) install_sudoers "\$\{src\}" "\$\{dst\}" "\$\{owner\}" "\$\{group\}" "\$\{mode\}"/,
    );
    const renderBody = /render\(\) \{[\s\S]*?\n\}/.exec(apply)?.[0];
    expect(renderBody, "apply.sh must define render()").toBeTruthy();
    expect(renderBody).toMatch(
      /install_config "\$\{tmp\}" "\$\{dst\}" "\$\{owner\}" "\$\{group\}" "\$\{mode\}"/,
    );
    const sudoersBody = /install_sudoers\(\) \{[\s\S]*?\n\}/.exec(apply)?.[0];
    expect(sudoersBody, "apply.sh must define install_sudoers()").toBeTruthy();
    expect(sudoersBody).not.toMatch(/0440|root -g root/);
    expect(sudoersBody).toMatch(
      /install -o "\$\{owner\}" -g "\$\{group\}" -m "\$\{mode\}" "\$\{tmp\}" "\$\{dst\}\.new"/,
    );
  });

  it("an unchanged config keeps its mtime, so a re-apply cannot fake a changed definition", () => {
    // The falsification of the fix, run against apply.sh's own install_config(): pin the
    // installed copy's mtime to a known instant, re-run, and require it to be untouched. A
    // changed definition, a wrong mode or a symlinked destination must still be written.
    const fx = configInstallFixture();
    try {
      const installedAt = 1_000_000_000;
      expect(fx.run().status).toBe(0);
      expect(readFileSync(fx.dst, "utf8")).toBe(readFileSync(fx.src, "utf8"));
      expect(statSync(fx.dst).mode & 0o777).toBe(0o644);

      utimesSync(fx.dst, installedAt, installedAt);
      const unchanged = fx.run();
      expect(unchanged.status).toBe(0);
      expect(unchanged.stdout).toContain("unchanged");
      expect(Math.round(statSync(fx.dst).mtimeMs / 1000)).toBe(installedAt);

      writeFileSync(fx.src, "[Unit]\nDescription=fixture changed\n");
      expect(fx.run().status).toBe(0);
      expect(readFileSync(fx.dst, "utf8")).toBe(readFileSync(fx.src, "utf8"));
      expect(Math.round(statSync(fx.dst).mtimeMs / 1000)).toBeGreaterThan(installedAt);

      chmodSync(fx.dst, 0o600);
      expect(fx.run().status).toBe(0);
      expect(statSync(fx.dst).mode & 0o777).toBe(0o644);

      const elsewhere = join(fx.dir, "elsewhere");
      writeFileSync(elsewhere, readFileSync(fx.src));
      rmSync(fx.dst);
      symlinkSync(elsewhere, fx.dst);
      expect(fx.run().status).toBe(0);
      expect(statSync(fx.dst).isSymbolicLink()).toBe(false);
      expect(readFileSync(fx.dst, "utf8")).toBe(readFileSync(fx.src, "utf8"));

      utimesSync(fx.dst, installedAt, installedAt);
      writeFileSync(fx.src, "[Unit]\nDescription=dry run\n");
      const dry = fx.run({ DRY_RUN: "1" });
      expect(dry.status).toBe(0);
      expect(dry.stdout).toContain("would: install");
      expect(readFileSync(fx.dst, "utf8")).not.toContain("dry run");
      expect(Math.round(statSync(fx.dst).mtimeMs / 1000)).toBe(installedAt);
    } finally {
      fx.cleanup();
    }
  });

  it("a re-apply over unchanged unit content leaves the deploy green; a changed definition does not", () => {
    // End to end across both scripts: install (apply.sh), the record a completed run leaves,
    // re-apply over unchanged content, then read the deploy's assertion. Only a changed definition
    // may make that red.
    const cfg = configInstallFixture();
    const prov = provenanceFixture();
    try {
      const installedAt = 2000;
      const lastRun = 3000;
      expect(cfg.run().status).toBe(0);
      utimesSync(cfg.dst, installedAt, installedAt);
      prov.writeRecord({ completed: lastRun });
      const before = prov.run({ unitFile: cfg.dst });
      expect(before.status).toBe(0);
      expect(before.stdout).toContain("backup unit healthy");

      // The re-apply the ticket was about: identical bytes, so nothing is written and the check
      // keeps reading the same mtime.
      expect(cfg.run().stdout).toContain("unchanged");
      const afterReapply = prov.run({ unitFile: cfg.dst });
      expect(afterReapply.status).toBe(0);
      expect(afterReapply.stdout).toContain("backup unit healthy");

      // A genuinely changed definition is written, so the unit must run again before it passes.
      writeFileSync(cfg.src, "[Unit]\nDescription=fixture changed\n");
      expect(cfg.run().status).toBe(0);
      const afterChange = prov.run({ unitFile: cfg.dst });
      expect(afterChange.status).toBe(1);
      expect(afterChange.stderr).toContain("BEFORE its current definition was installed");
    } finally {
      cfg.cleanup();
      prov.cleanup();
    }
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
      // bootstrap loses that line. The order (apply.sh before this run) matters too: apply.sh
      // installs the unit, so a record written first is stale and cannot be cleared by the
      // pre-record deployed bundle.
      expect(setup).toContain("> cd /srv/kajianq-src");
      expect(setup).toContain(
        "sudo bun provision/vps/backup/kajianq-backup.mjs \\\n" +
          ">   --env-file /etc/kajianq/backup.env \\\n" +
          ">   --label bootstrap \\\n" +
          ">   --record /var/lib/kajianq/backup-provenance",
      );
      expect(setup).toContain("pull → `apply.sh` → bootstrap → deploy");

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
      // On a transition box the stale record predates the unit that apply.sh just installed, and
      // `systemctl start` still runs the pre-record bundle; the refusal must point at the checkout
      // bootstrap instead of ending at that dead end.
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

  it("refuses a unit run that dies before the job body (mutation: no ExecStartPre marker)", () => {
    // The unit's start sequence, as installed: ExecStartPre marks the record pending before
    // ExecStart can fail (a moved bun, an absent deployed bundle, a broken ExecStart), and the
    // job body never runs to replace the marker. The fixture seeds the previous success first —
    // exactly the state a pre-body death leaves current if nothing marks the run.
    const service = directives("provision/vps/systemd/kajianq-backup.service");
    const marker = /^ExecStartPre=(.+)$/m.exec(service)?.[1];
    expect(marker, "the unit must mark a run pending before ExecStart").toBe(
      "/usr/local/sbin/kajianq-backup-pending",
    );
    // apply.sh installs the repository script at that path, so executing it here is executing
    // what the unit executes. The install is outside the deploy tree: /srv/kajianq is
    // deploy-owned and replaced with --delete, so a marker there could be rewritten by the
    // identity the record binds.
    expect(read("provision/vps/apply.sh")).toMatch(
      /^backup-marker\|config\|backup\/kajianq-backup-pending\.sh\|\/usr\/local\/sbin\/kajianq-backup-pending\|root\|root\|755$/m,
    );

    const fx = provenanceFixture();
    try {
      fx.writeRecord();
      expect(fx.run().status).toBe(0);

      const marked = runPendingMarker(fx.record);
      expect(marked.status, marked.stderr).toBe(0);
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

  it("marks a run pending atomically and world-readably (mutation: a torn or root-only marker)", () => {
    // The marker replaces the previous success before anything in the job can fail. It is
    // written through a same-directory temp file renamed into place, so the deploy identity
    // reads a whole record rather than a half-written one, and no temp file is left behind.
    const dir = mkdtempSync(join(tmpdir(), "kajianq-pending-"));
    const bin = mkdtempSync(join(tmpdir(), "kajianq-pending-bin-"));
    const record = join(dir, "backup-provenance");
    const mvLog = join(bin, "mv.log");
    const mvBefore = join(bin, "record-before");
    try {
      const previous = provenanceRecord();
      writeFileSync(record, previous);
      const realMv = spawnSync("/bin/sh", ["-c", "command -v mv"], {
        encoding: "utf8",
      }).stdout.trim();
      expect(realMv).not.toBe("");
      writeFileSync(
        join(bin, "mv"),
        [
          "#!/bin/sh",
          // Log the argv the marker hands mv, and snapshot the destination first: the test then
          // sees what the record held at the moment of the rename.
          'if [ -z "${MV_LOG:-}" ] || [ -z "${MV_BEFORE:-}" ] || [ -z "${REAL_MV:-}" ]; then exit 1; fi',
          ': > "${MV_LOG}"',
          'for arg in "$@"; do printf \'%s\\n\' "${arg}" >> "${MV_LOG}"; done',
          'for arg in "$@"; do dest="${arg}"; done',
          'cp -- "${dest}" "${MV_BEFORE}" 2>/dev/null || :',
          'exec "${REAL_MV}" "$@"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const marked = runPendingMarker(record, {
        stubDir: bin,
        mvLog,
        mvBefore,
        realMv,
      });
      expect(marked.status, marked.stderr).toBe(0);
      expect(statSync(record).mode & 0o777).toBe(0o644);
      expect(readdirSync(dir)).toEqual(["backup-provenance"]);
      const body = readFileSync(record, "utf8");
      expect(body).toMatch(/^status=pending$/m);
      expect(body).toMatch(/^started_at=\d+$/m);
      expect(body).toMatch(/^completed_at=0$/m);

      // A rename, not an in-place write: the marker hands mv a temp file in the record's own
      // directory and the record path as the destination. A direct `printf > record` never
      // reaches this stub, and a temp file outside that directory would not rename atomically.
      const args = readFileSync(mvLog, "utf8").trim().split("\n");
      expect(args.slice(0, 2)).toEqual(["-f", "--"]);
      expect(args).toHaveLength(4);
      const [tmp, dest] = args.slice(2);
      expect(dest).toBe(record);
      expect(dirname(tmp)).toBe(dir);
      expect(tmp).not.toBe(record);
      // At the rename the record still held the previous success: the pending body existed only
      // in the temp file until the move.
      expect(readFileSync(mvBefore, "utf8")).toBe(previous);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
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
    const service = directives("provision/vps/systemd/kajianq-backup.service");
    expect(service).toContain("EnvironmentFile=-/etc/kajianq/backup.env");

    const backup = backupRunFixture();
    const prov = provenanceFixture();
    try {
      // A previous success is current before this run, and would stay current without the
      // marker.
      writeFileSync(backup.record, provenanceRecord());
      expect(prov.run({ recordFile: backup.record }).status).toBe(0);

      const marked = runPendingMarker(backup.record);
      expect(marked.status, marked.stderr).toBe(0);
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
    const apply = read("provision/vps/apply.sh");
    // The writer and the reader must name the same path, and it must not sit under the deploy
    // root: /srv/kajianq belongs to the deploy identity, so a root-owned record there could be
    // renamed away, and the shipped subdirectories are replaced with `rsync --delete`.
    expect(provenance).toMatch(/RECORD_DIR = "\/var\/lib\/kajianq"/);
    expect(provenance).toMatch(/RECORD_PATH = `\$\{RECORD_DIR\}\/backup-provenance`/);
    expect(check).toMatch(/RECORD_FILE="\$\{2:-\/var\/lib\/kajianq\/backup-provenance\}"/);
    expect(provenance).not.toMatch(/RECORD_DIR = "\/srv\/kajianq/);
    expect(backup).toMatch(
      /import \{ RECORD_PATH, recordBody, writeRecordFile \} from "\.\/provenance\.mjs"/,
    );
    // apply.sh provisions the directory root-owned and traversable; the job writes the file
    // 0644, so the deploy identity can read a proof it cannot write.
    expect(apply).toMatch(/install -d -o root -g root -m 0755 \/var\/lib\/kajianq/);
    expect(provenance).toMatch(/writeFileSync\(tmp, body, \{ mode: 0o644 \}\)/);
    // The unit's pre-body marker must write THAT record: a marker at another path would leave
    // the preflight reading the previous success, and one under the deploy root could be
    // replaced by the identity the proof binds.
    const pending = read("provision/vps/backup/kajianq-backup-pending.sh")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(pending).toMatch(/RECORD="\$\{1:-\/var\/lib\/kajianq\/backup-provenance\}"/);
    expect(pending).not.toMatch(/\/srv\/kajianq/);
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
      "rsync -az",
      "sudo ${SYSTEMCTL} restart",
      "sudo ${SYSTEMCTL} start kajianq-cron.service",
    ]) {
      const at = script.indexOf(mutation);
      expect(at, `deploy.sh must still contain: ${mutation}`).toBeGreaterThan(-1);
      expect(preflight, `the provenance preflight must precede ${mutation}`).toBeLessThan(at);
    }
  });

  it("apply.sh clears the backup unit's stale failure state after installing it", () => {
    // The failure is attached to the unit NAME, so without reset-failed `systemctl status`
    // reports a failure the unit does not have; the deploy's gate does not depend on the reset.
    const apply = read("provision/vps/apply.sh");
    expect(apply).toMatch(/systemctl reset-failed kajianq-backup\.service/);
    // Order matters: the reset is meaningless before the new unit is in place.
    expect(apply.indexOf("reset-failed kajianq-backup.service")).toBeGreaterThan(
      apply.indexOf("systemd/kajianq-backup.service"),
    );
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
    // The shipped unit must point at that artifact and at nothing else.
    const service = directives("provision/vps/systemd/kajianq-backup.service");
    expect(service).toMatch(/ExecStart=\/usr\/bin\/bun run \/srv\/kajianq\/api\/backup\.js/);
    // No checkout path may remain anywhere in the unit.
    expect(service).not.toMatch(/kajianq-src/);
    // apply.sh installs it verbatim — no render() call, since there is nothing to substitute.
    const apply = read("provision/vps/apply.sh");
    expect(apply).not.toMatch(/render "\$\{SRC\}\/systemd\/kajianq-backup\.service"/);
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

  it("the deploy grant authorizes exactly the sudo the deploy script runs", () => {
    // The deploy's privileged half is sudo over ssh, where a missing grant fails as "a password
    // is required" — naming neither the rule nor the command. Both directions are pinned: every
    // sudo'd command is granted, and every granted command is used, so an unused grant cannot
    // accumulate silently.
    const script = read("provision/vps/deploy/deploy.sh");
    const grant = read("provision/vps/sudoers/kajianq-deploy");

    // Extract the sudo'd argv from the script's remote commands. The `sudo ` may follow a shell
    // quote, so quotes and whitespace are normalized first, and `${SYSTEMCTL}` is resolved to
    // the literal the grant carries, since sudoers matches the expanded command string. The
    // capture runs to the next shell separator, so an argument-bearing call is compared in full.
    const resolved = script
      .replace(/\$\{SYSTEMCTL\}/g, "/usr/bin/systemctl")
      .replace(/["']/g, "\n");
    const used = [...resolved.matchAll(/sudo\s+(\/usr\/bin\/systemctl\s+[^\n;|&]+)/g)].map((m) =>
      m[1].trim(),
    );
    expect(used.length).toBeGreaterThanOrEqual(2);

    // The grant's command list: whitespace is collapsed first (the second entry follows a `\`
    // line continuation), and the capture runs to the entry boundary so an extra-argument grant
    // is compared in full.
    const grantBody = grant
      .slice(grant.indexOf("NOPASSWD:"))
      .replace(/\\\s*\n/g, " ")
      .replace(/\s+/g, " ");
    const granted = [...grantBody.matchAll(/(\/usr\/bin\/systemctl\s+[^,]+?)\s*(?:,|$)/g)].map(
      (m) => m[1].trim(),
    );
    expect(granted.length).toBeGreaterThanOrEqual(2);

    for (const command of used) {
      expect(granted, `deploy runs \`sudo ${command}\` but the grant omits it`).toContain(command);
    }
    for (const command of granted) {
      expect(used, `the grant allows \`${command}\` but the deploy never runs it`).toContain(
        command,
      );
    }
  });

  it("the deploy grant is scoped: no wildcards, no shell, one identity, absolute paths", () => {
    // visudo -cf proves the file PARSES, not that it is narrow — a wildcard command parses
    // perfectly — so the scope has to be asserted here.
    const grant = read("provision/vps/sudoers/kajianq-deploy");
    const rules = grant
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("#"))
      .join("\n");

    expect(rules).not.toMatch(/\*/);
    expect(rules).not.toMatch(/\?|\[[^\]]/);
    // No shell, and no ALL-command form: ALL would make the exact-command scoping decorative.
    expect(rules).not.toMatch(/NOPASSWD:\s*ALL/);
    for (const shell of ["bash", "sh ", "sudo", "env "]) {
      expect(rules).not.toMatch(new RegExp(`/usr/bin/${shell.trim()}`));
    }
    // Absolute binary paths only: sudoers matches the command string exactly.
    expect(rules).toMatch(/\/usr\/bin\/systemctl restart kajianq-api\.service/);
    expect(rules).toMatch(/\/usr\/bin\/systemctl start kajianq-cron\.service/);
    // The read-only check must not be granted: unit state is world-readable.
    expect(rules).not.toMatch(/is-active/);
  });

  it("apply.sh installs the deploy grant only behind visudo, and the account name cannot drift", () => {
    // Three places must agree on the deploy identity: the account apply.sh creates, the sudoers
    // grant, and CI's VPS_USER — a drift produces the same unnamed "password is required" failure.
    const apply = read("provision/vps/apply.sh");
    const grant = read("provision/vps/sudoers/kajianq-deploy");

    expect(apply).toMatch(/DEPLOY_USER="kajianq-deploy"/);
    expect(grant).toMatch(/^kajianq-deploy ALL=\(root\)/m);
    // The install is gated on the parse: a malformed sudoers.d file can lock sudo out of the
    // box, so visudo must run BEFORE the mv into place. Anchor on the real invocation, not a
    // comment that merely mentions visudo.
    const visudoCall = /^\s*if ! visudo -cf\b/m.exec(apply);
    expect(visudoCall, "apply.sh must gate the sudoers install on visudo -cf").not.toBeNull();
    expect(apply.indexOf(visudoCall[0])).toBeLessThan(apply.indexOf('mv -f "${dst}.new"'));
    // A failed parse must abort the apply, not fall through to the install.
    expect(apply).toMatch(/if ! visudo -cf[^]*?exit 1/);
    // Staged with a dot in the name: sudoers(5) ignores dot-named files.
    expect(apply).toMatch(/\$\{dst\}\.new/);
    // The grant must not be left world- or group-readable: the table's row is
    // 440 and install_sudoers installs exactly the row's owner, group and mode.
    expect(apply).toMatch(
      /^deploy-grant\|sudoers\|sudoers\/kajianq-deploy\|\/etc\/sudoers\.d\/kajianq-deploy\|root\|root\|440$/m,
    );
    expect(apply).toMatch(/install -o "\$\{owner\}" -g "\$\{group\}" -m "\$\{mode\}" "\$\{tmp\}"/);
    expect(apply).not.toMatch(/install -o root -g root -m 0440/);
    // The drift assert runs against the shipped file, not a substituted value.
    expect(apply).toMatch(/grep -q "\^\$\{DEPLOY_USER\} ALL=\(root\)"/);
  });

  it("the deploy identity owns the deployed tree, so rsync needs no group-write grant", () => {
    // rsync -az implies -t and --delete removes stale assets; both need write access to the
    // tree, which ownership by the deploy identity provides without widening the service
    // account. The recursive chown is the migration half: install -d leaves existing files
    // owned by the previous owner.
    const apply = read("provision/vps/apply.sh");
    expect(apply).toMatch(/install -d -o "\$\{DEPLOY_USER\}" -g "\$\{DEPLOY_USER\}" -m 0755/);
    expect(apply).toMatch(
      /chown -R "\$\{DEPLOY_USER\}:\$\{DEPLOY_USER\}" \/srv\/kajianq\/api \/srv\/kajianq\/web/,
    );
    // The service account must NOT gain write access as the cheaper fix: the API process never
    // writes to this tree, so that would widen the serving identity for no requirement.
    expect(apply).not.toMatch(/install -d -o kajianq -g kajianq -m 2755/);
  });

  it("the deploy key installation never comes from the repository and never overwrites", () => {
    // The repository is public, so a key can only arrive through --deploy-pubkey at provisioning
    // time; appending (not overwriting) keeps the prod key pair from evicting staging's.
    const apply = read("provision/vps/apply.sh");
    expect(apply).toMatch(/--deploy-pubkey/);
    expect(apply).not.toMatch(/authorized_keys.*<<<.*id_(ed25519|rsa)/);
    expect(apply).toMatch(/grep -qxF "\$\{key\}" "\$\{deploy_home\}\/\.ssh\/authorized_keys"/);
    expect(apply).toMatch(/install -d -o "\$\{DEPLOY_USER\}" -g "\$\{DEPLOY_USER\}" -m 0700/);
  });

  it("apply.sh never installs the deploy grant for a name the grant does not name", () => {
    // Negative control for the parity assert: a real comparison, not a constant that passes.
    const grant = read("provision/vps/sudoers/kajianq-deploy");
    const apply = read("provision/vps/apply.sh");
    const deployUser = /DEPLOY_USER="([^"]+)"/.exec(apply)?.[1];
    expect(deployUser).toBe("kajianq-deploy");
    expect(grant).toMatch(new RegExp(`^${deployUser} ALL=\\(root\\)`, "m"));
    // A different name must NOT satisfy the same assertion, or the test above would pass on any grant.
    expect(grant).not.toMatch(/^some-other-user ALL=\(root\)/m);
  });

  it("the api.env example carries every key the serving composition root reads, as placeholders", () => {
    // The example must list exactly the PASSTHROUGH_KEYS set in apps/api/src/lib/server.ts (the
    // two sets drift only together), set KAJIANQ_WEB_ROOT to the deployed path (the default 503s
    // every SPA route while health stays green), and hold placeholders only — the loopback
    // 127.0.0.1 is exempt as the Postgres listener's own address.
    const example = read("provision/vps/api.env.example");
    const server = readFileSync(resolve(process.cwd(), "apps/api/src/lib/server.ts"), "utf8");
    const keys = [...server.matchAll(/^\s*"([A-Z_0-9]+)",?$/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(8);
    for (const key of keys) {
      expect(example, key).toMatch(new RegExp(`^${key}=`, "m"));
    }
    // The template must ship the recorded `staging` label so a re-arm reddens here rather than
    // on a rebuilt box (ADR-0044 decision 2). Asserted on the parsed value — systemd strips
    // whitespace and takes the last assignment — and on there being one assignment.
    const assignments = example.match(/^\s*APP_ENV\s*=/gm) ?? [];
    expect(assignments).toHaveLength(1);
    expect(parseEnvFile(example).APP_ENV).toBe("staging");
    expect(example).toMatch(/^KAJIANQ_WEB_ROOT=\/srv\/kajianq\/web$/m);
    const noLoopback = example.replace(/127\.0\.0\.1/g, "<loopback>");
    expect(noLoopback).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(example).not.toMatch(/postgres:\/\/(?!kajianq:CHANGE_ME)/);
    // Real secrets never enter the repo: every provider key line is a placeholder.
    for (const key of ["GEMINI_PAID_API_KEY", "DEEPSEEK_API_KEY"]) {
      expect(example).toMatch(new RegExp(`^${key}=CHANGE_ME$`, "m"));
    }
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
