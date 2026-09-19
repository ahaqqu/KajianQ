import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BACKUP_KEEP_DAILY,
  LABEL_RE,
  LOG_RETENTION_DAYS,
  RECLAIM_SQL,
  REQUIRED_ENV,
  assertManifest,
  buildManifest,
  erasureSql,
  formatCounts,
  labelTag,
  missingEnv,
  parseEnvFile,
  readLabel,
  retentionArgs,
  sha256Hex,
  verifyRestore,
} from "../../provision/vps/backup/lib.mjs";

/**
 * VPS privacy-hardening policy (#180, ADR-0043 decision 4).
 *
 * The backup/restore tooling is only as trustworthy as the decisions inside it:
 * the rolling window, the integrity check, and the erasure that a restore must
 * re-apply. Those decisions are pure functions here so they can be asserted
 * directly — the end-to-end path against a real Postgres is
 * `provision/vps/backup/restore-drill.mjs`, run by the vps-restore-drill
 * workflow and by the owner on the host.
 */

const MANIFEST = buildManifest({
  label: "daily-20260919t031500z",
  bytes: 4096,
  sha256: "a".repeat(64),
  counts: { users: 3, sessions: 3, chat_messages: 5, answer_traces: 5 },
  source: { host: "db.internal", database: "kajianq" },
  tool: { pgDump: "pg_dump (PostgreSQL) 18.6", generator: "test" },
});

describe("retention policy matches ADR-0043 decision 4", () => {
  it("keeps one backup per day for 30 days — the session TTL, so a backup cannot outlive its data", () => {
    expect(BACKUP_KEEP_DAILY).toBe(30);
    expect(retentionArgs()).toEqual(["forget", "--keep-daily", "30", "--prune"]);
  });

  it("prunes, so the window is enforced rather than merely reported", () => {
    // Without --prune restic keeps the snapshots it "forgot" in the repository
    // and the storage grows unbounded — the exact failure this ticket exists to
    // prevent.
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
    // The manifest is uploaded next to the dump; a password in it would be a
    // credential in the backup target.
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
    // pg-conn.mjs's CORPUS_TABLES partition exists because it compares a
    // manifest to a LIVE database. A fresh restore has nothing else writing to
    // it, so every table is strict here.
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
    // The invariant this pins: the restore's reclamation and
    // cleanupExpiredSessions must not drift. If the adapter's SQL changes, this
    // test fails and points at the restore path — otherwise a restore would
    // silently stop reclaiming expired sessions while the cron still did.
    //
    // The adapter binds its cutoff as a parameter (`${before.toISOString()}`)
    // while RECLAIM_SQL uses `now()`; both are the same predicate, so the
    // comparison normalizes the bound value and whitespace before matching.
    const normalize = (text) =>
      text
        .replace(/\s+/g, " ")
        .replace(/\$\{before\.toISOString\(\)\}/g, "now()")
        .trim();
    const adapter = normalize(
      readFileSync(resolve(process.cwd(), "packages/infra/src/rag-store-neon-session.ts"), "utf8"),
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

  it("builds the Art. 17 cascade by user id and refuses anything else", () => {
    expect(erasureSql("33333333-3333-4333-8333-333333333333")).toBe(
      "DELETE FROM users WHERE id = '33333333-3333-4333-8333-333333333333'",
    );
    // A non-UUID is refused rather than interpolated into the statement.
    for (const bad of ["", "1 OR 1=1", "not-a-uuid"]) {
      expect(() => erasureSql(bad)).toThrow(/UUID/);
    }
  });

  it("names the rows the drill proves gone and the rows it proves survive", () => {
    // The drill's assertions are the acceptance criterion's "tested by restoring
    // once into a scratch location" made executable. This pins that the drill
    // still asserts both directions: the negative control (resurrected rows
    // present) and the erase-then-match direction (erased rows gone, live rows
    // intact). A drill that only asserted one side would pass vacuously.
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
  /**
   * Drop comment lines before asserting directives. Several files explain why a
   * directive is NOT used (e.g. nginx's logrotate stanza says "no copytruncate
   * is used"), and a substring assertion against the raw text would read that
   * explanation as the directive itself.
   */
  const directives = (rel) =>
    read(rel)
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

  it("the proxy access log records the client IP and nothing about the visitor beyond it", () => {
    const conf = directives("provision/vps/nginx/kajianq.conf");
    // The log format must carry $remote_addr (the IP is the declared data
    // category in the Art. 30 record)…
    expect(conf).toMatch(/log_format kajianq_access[^;]*\$remote_addr/);
    // …and must NOT widen it with device or navigation identifiers.
    expect(conf).not.toMatch(/\$http_user_agent/);
    expect(conf).not.toMatch(/\$http_referer/);
  });

  it("the proxy establishes CF-Connecting-IP from $remote_addr, so the rate limiter cannot be spoofed", () => {
    // apps/api/src/lib/middleware.ts reads CF-Connecting-IP. If nginx ever passed
    // the client's own header through, a caller could mint a fresh limiter key
    // per request. Pinning the write here makes that a test failure.
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
    expect(conf).toMatch(/rotate 14\b/);
    expect(conf).toMatch(/daily/);
    expect(conf).toMatch(/maxsize/);
    // nginx reopens its logs on SIGUSR1; copytruncate would be the wrong tool
    // (and would risk splitting a line).
    expect(conf).toContain("kill -USR1");
    expect(conf).not.toContain("copytruncate");
    // The error log is IP-bearing too, so it must be in the same stanza.
    expect(conf).toContain("/var/log/nginx/kajianq.error.log");
  });

  it("the Postgres logrotate policy rotates and truncates in place, since Postgres never reopens", () => {
    const conf = directives("provision/vps/logrotate/kajianq-postgres");
    expect(conf).toMatch(/rotate 14\b/);
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
    // A DATABASE_URL inline in the unit would be readable in the process table
    // and in the journal.
    expect(unit).not.toMatch(/DATABASE_URL=/);
    expect(unit).toContain("NoNewPrivileges=yes");
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
