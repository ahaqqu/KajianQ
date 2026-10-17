import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import {
  BACKUP_KEEP_DAILY,
  LABEL_RE,
  LOG_RETENTION_DAYS,
  RECLAIM_SQL,
  REQUIRED_ENV,
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

/** The executable lines of every bash block in a doc section, comments stripped. */
function bashLines(text) {
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .join("\n")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
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
    // The restore script resolves BOTH forms through resolveScratchTarget, so neither the
    // flag nor RESTORE_TARGET_URL can reach pg_restore without the comparison above.
    const restore = readFileSync(
      resolve(process.cwd(), "provision/vps/backup/kajianq-restore.mjs"),
      "utf8",
    );
    expect(restore).toMatch(/resolveScratchTarget\(/);
    expect(restore).toMatch(/flagTarget: argAfter\(argv, "--target-url"\)/);
    expect(restore).toMatch(/env: process\.env/);
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
    // Precedence, observed end to end: with a live URL in the env but a scratch flag, the run
    // gets past the guard (and dies at the missing restic), never on the guard's message.
    const passed = runRestore(["--target-url", scratch], {
      PGDATABASE_URL: live,
      RESTORE_TARGET_URL: live,
    });
    expect(passed.stderr).not.toMatch(
      /names the live database|scratch target is required|PGDATABASE_URL is required/,
    );
    expect(passed.stderr).toMatch(/restic/);
  });

  it("prints a restore plan that never hands a credentialed URL to a shell", () => {
    // The property, not the copy: whatever the plan's wording, no line it prints may carry a
    // URL with embedded credentials (that is what `ps` shows for the process's life) or hand
    // an operator a URL variable to type. The assertion survives any rewrite of the message.
    const script = resolve(process.cwd(), "packages/infra/scripts/db-snapshot.mjs");
    const plan = spawnSync("bun", [script, "restore-plan", "probe-label"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    expect(plan.status, plan.stderr).toBe(0);
    expect(plan.stdout).not.toMatch(CREDENTIALED_URL);
    expect(plan.stdout).not.toMatch(/\$TARGET_URL/);
  });

  it("teaches no restore command that carries a credentialed URL", () => {
    // Same invariant over what the operator is told to run: a URL with a user:password pair
    // in a documented command line is readable through `ps` and kept in shell history.
    const ops = readFileSync(resolve(process.cwd(), "docs/VPS-OPERATIONS.md"), "utf8");
    const section = ops.slice(ops.indexOf("### 2.7"), ops.indexOf("### 2.8"));
    const setup = readFileSync(resolve(process.cwd(), "docs/VPS-SETUP.md"), "utf8");
    const step = setup.slice(
      setup.indexOf("**Restoring for real**"),
      setup.indexOf("### Confirm the backup timer"),
    );
    for (const [name, text] of [
      ["VPS-OPERATIONS §2.7", section],
      ["VPS-SETUP restore step", step],
    ]) {
      expect(bashLines(text), name).not.toMatch(CREDENTIALED_URL);
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
    const restore = readFileSync(
      resolve(process.cwd(), "provision/vps/backup/kajianq-restore.mjs"),
      "utf8",
    );
    expect(restore).toMatch(/dbLocation\(targetUrl\)\.database/);
    expect(restore).not.toMatch(/"-d",\s*targetUrl/);
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

  it("the setup doc exists and carries the steps a fresh box cannot infer", () => {
    // The repository is open source, so the provisioning path has to be followable by someone
    // who is not the owner: pin the steps a reader cannot derive from the configs.
    const setup = read("docs/VPS-SETUP.md");

    // 1. Bun must be installed at /usr/bin/bun: the units run with ProtectHome=yes, so a
    //    home-directory Bun is invisible and ExecStart fails for a binary that exists.
    expect(setup).toMatch(/\/usr\/bin\/bun/);
    // The doc must name the constraint, not just the path.
    expect(setup).toMatch(/ProtectHome/);
    // It must NOT recommend the home-directory installer that causes it.
    expect(setup).not.toMatch(/curl -fsSL https:\/\/bun\.sh\/install/);

    // 2. apply.sh installs the Postgres POSTURE but creates no role or database.
    const apply = read("provision/vps/apply.sh");
    expect(apply).not.toMatch(/CREATE ROLE|createuser/);
    expect(setup).toMatch(/CREATE ROLE kajianq LOGIN/);

    // 3. The two chat-path precondition keys, without which health stays green while every
    //    question fails its embedder or reviewer stage.
    expect(setup).toMatch(/GEMINI_PAID_API_KEY/);
    expect(setup).toMatch(/DEEPSEEK_API_KEY/);

    // 4. The rate-bypass public key is committed, so an unmodified fork verifies tokens minted
    //    by anyone holding the project's private key: a public setup doc has to say so.
    const bypass = read("apps/api/src/lib/rate-bypass.ts");
    expect(bypass).toMatch(/RATE_BYPASS_PUBLIC_KEY_B64 = "/);
    expect(setup).toMatch(/rotate/i);
  });

  it("the setup doc proves the backup with the SERVICE, not a direct script run", () => {
    // The doc must prove the backup with the service, not `kajianq-backup.mjs` directly: a
    // direct run writes a snapshot but leaves the unit's ExecMainStatus/ExecMainExitTimestamp
    // untouched, and the deploy's gate reads exactly those.
    const setup = read("docs/VPS-SETUP.md");
    expect(setup).toMatch(/sudo systemctl start kajianq-backup\.service/);
    // The distinction must be stated, or the next reader reintroduces it.
    expect(setup).toMatch(/ExecMainStatus/);
  });

  it("the restore-drill workflow does not claim its image matches the box's major", () => {
    // The image is the schema under test, not a claim about the box's Postgres major — a wrong
    // version claim in a comment is how a reader concludes the drill tests something it does not.
    const workflow = read(".github/workflows/vps-restore-drill.yml");
    expect(workflow).toMatch(/pgvector\/pgvector:pg18/);
    expect(workflow).not.toMatch(/the Postgres major the box is provisioned with/);
  });

  it("the setup doc is reachable from the README and the operator's manual", () => {
    // An unlinked doc is an unfound doc: a self-hoster has to find it from the front page.
    expect(read("README.md")).toMatch(/docs\/VPS-SETUP\.md/);
    expect(read("docs/VPS-OPERATIONS.md")).toMatch(/VPS-SETUP\.md/);
  });

  it("the retired VPS docs are gone and their load-bearing content moved, not lost", () => {
    // This test keeps the retirement honest: it fails if a retired file reappears (two sources
    // of truth), and if the content that had to survive is dropped by a later edit.
    const setup = read("docs/VPS-SETUP.md");
    for (const retired of [
      "docs/VPS-BASELINE-SETUP.md",
      "docs/VPS-CUTOVER-RUNBOOK.md",
      "docs/VPS-HARDENING-RUNBOOK.md",
      "docs/neon-sizing-issue-4.md",
      // A stale link or a re-created file here means the rename was half-applied.
      "docs/SELF-HOSTING-GUIDE.md",
    ]) {
      expect(existsSync(resolve(process.cwd(), retired)), retired).toBe(false);
    }

    // The hardening runbook's substance had to land in the setup doc, or the merge silently
    // dropped the privacy posture: the config-as-code inventory, the nginx rationale, the
    // CI-side VPS_USER flip, and the retention verification.
    expect(setup).toMatch(/Everything `apply\.sh` places/);
    expect(setup).toMatch(/Reverse proxy: nginx, not Caddy/);
    expect(setup).toMatch(/Retention, not IP masking/);
    expect(setup).toMatch(/VPS_USER/);
    expect(setup).toMatch(/Verify retention once traffic exists/);
    // The retention table's four rows, which ARE the Art. 30 values.
    expect(setup).toMatch(/restic `--keep-daily`/);
    expect(setup).toMatch(/journald\/kajianq\.conf/);

    // 1. The acceptance-criteria walk-through had to survive: it is what the issue closes against.
    const record = read("docs/VPS-CUTOVER-RECORD.md");
    expect(record).toMatch(/AC-1\b/);
    expect(record).toMatch(/AC-16\b/);
    expect(record).toMatch(/## Acceptance criteria/);
    // The baseline session's record is the chain-of-custody start; its evidence table came along.
    expect(record).toMatch(/baseline session/i);
    expect(record).toMatch(/Debian 13 \(trixie\)/);

    // 2. The one procedure in the cutover runbook that outlived its vendor: moving an existing
    //    database onto a box — snapshot-verify-ship-compare, not Cloudflare or Neon specifics.
    expect(setup).toMatch(/## 12\. Moving an existing database/);
    expect(setup).toMatch(/db:snapshot create/);
    expect(setup).toMatch(/pg_restore/);
    expect(setup).toMatch(/db:snapshot verify/);

    // 3. The disk figure: the setup runbook is what a self-hoster sizes against, and the
    //    schema's sizing record must name the host decision in force rather than the retired one.
    expect(setup).toMatch(/17–18 GiB/);
    expect(setup).toMatch(/adr\/0020-neon-dual-vector-sizing\.md/);
    const adr = read("adr/0020-neon-dual-vector-sizing.md");
    expect(adr).toMatch(/ADR-0043|ADR-0044/);
    expect(adr).toMatch(/docs\/VPS-SETUP\.md/);
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
