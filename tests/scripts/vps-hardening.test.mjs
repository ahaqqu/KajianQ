import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  it("the Art. 17 statement matches production deleteUserCascade — the restore path cannot drift", () => {
    // Production erasure (DELETE /v1/auth/me → deleteUserCascade) executes a parameterized
    // `DELETE FROM users WHERE id = ${userId}`; the restore re-applies the same statement with
    // the id bound as a psql variable. The comparison normalizes the adapter's tagged template
    // against the restore statement's `:'uid'` binding — the same placeholder role.
    const normalize = (text) =>
      text
        .replace(/\s+/g, " ")
        .replace(/\$\{userId\}/g, ":'uid'")
        .trim();
    const adapter = normalize(
      readFileSync(
        resolve(process.cwd(), "packages/infra/src/rag-store-postgres-session.ts"),
        "utf8",
      ),
    );
    expect(adapter).toContain(normalize(erasureSql()));
  });

  it("binds the erasure user id as a psql variable, never into the statement text", () => {
    expect(erasureSql()).toBe("DELETE FROM users WHERE id = :'uid'");
    // Fixed text: the id travels in erasurePsqlArgs, quoted by psql itself.
    expect(erasureSql()).not.toMatch(/\$\{/);
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
    expect(service).toContain("EnvironmentFile=/etc/kajianq/backup.env");
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
      renderBody.indexOf("install -o root"),
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
    // required-name gate, and the assignment carries no `:-` default. Reverting either one alone
    // would let an operator env file that omits the tree ship to /srv/kajianq while reporting
    // success — the failure this contract closes (the script's header states it).
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

  it("the deploy fails on a broken backup unit rather than trusting an active timer", () => {
    // `is-active` means the SCHEDULE is armed, never that the job works, so the deploy reads
    // the service's own run record instead.
    const script = read("provision/vps/deploy/deploy.sh");
    // The exit status is the assertion...
    expect(script).toMatch(/systemctl show kajianq-backup\.service -p ExecMainStatus/);
    expect(script).toMatch(/if \[ "\$status" != "0" \][^]*?exit 1/);
    // ...and the timestamp-vs-install comparison is the other half, because `Result` cannot
    // distinguish "the last run passed" from "no run since the unit changed".
    expect(script).toMatch(/ExecMainExitTimestamp --timestamp=unix/);
    expect(script).toMatch(/stat -c %Y \/etc\/systemd\/system\/kajianq-backup\.service/);
    expect(script).toMatch(/if \[ "\$exited" -lt "\$installed" \][^]*?exit 1/);
    // A never-run unit must fail too, not pass on empty strings.
    expect(script).toMatch(/if \[ -z "\$exited" \][^]*?exit 1/);
    // Failures name the follow-up, or the operator reads a bare code.
    expect(script).toMatch(/journalctl -u kajianq-backup\.service/);
    // `Result` must NOT be the assertion: `reset-failed` clears it to `success` while leaving
    // ExecMainStatus=1, so gating on it reports a failed run as healthy.
    expect(script).not.toMatch(/-p Result/);
    // And it must not merely re-check the timer, the reassuring-looking field.
    expect(script).not.toMatch(/is-active --quiet kajianq-backup\.timer/);
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
    // The grant must not be left world- or group-readable.
    expect(apply).toMatch(/install -o root -g root -m 0440/);
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
