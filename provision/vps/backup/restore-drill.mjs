#!/usr/bin/env bun
/**
 * restore-drill.mjs — the executable restore test (#180, ADR-0043 decision 4).
 *
 * The ADR's backup clause has two halves: encrypted-at-rest rolling backups,
 * and "a restore re-applies erasure — otherwise a restored row would silently
 * resurrect data the live store had deleted". This drill proves the second half
 * end to end. It is the mechanism the ticket's "tested by restoring once into a
 * scratch location" criterion points at, and it runs in CI
 * (.github/workflows/vps-restore-drill.yml) against a scratch Postgres with
 * pgvector.
 *
 *   bun provision/vps/backup/restore-drill.mjs --admin-url postgres://user:pass@host:5432/postgres
 *
 * Flow. Nothing here touches a live store: the drill creates and drops its own
 * two scratch databases from --admin-url (the maintenance connection).
 *
 *   schema    apply the REAL engine migration to the source (pgvector required)
 *   seed      personal data in the source: a live anonymous session whose chat
 *             must survive, an expired session whose orphaned user carries a
 *             chat + trace, and a subject who exercises Art. 17 after the backup
 *   backup    the production script: pg_dump -> manifest -> restic (encrypted)
 *   erase     simulate the live store after the backup: erase the subject and
 *             run the nightly reclamation (cleanupExpiredSessions semantics)
 *   restore   the production script: decrypt + restore into the scratch target
 *   assert 1  the restored target DOES hold the erased rows — the negative
 *             control. Without it the drill could pass while testing nothing.
 *   erase     re-apply the reclamation and the subject erasure to the target
 *   assert 2  the target now matches the live source: erased rows gone, the
 *             live user's chat intact
 *
 * Exit 0 only when every assertion holds. Any other outcome is a hard failure —
 * a restore drill that cannot fail is not a drill.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RECLAIM_SQL, erasureSql } from "./lib.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MIGRATIONS = `${REPO_ROOT}packages/infra/migrations/0001_init.sql`;

const argv = process.argv.slice(2);
const argAfter = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const adminUrl = argAfter("--admin-url");
if (!adminUrl) {
  console.error(
    "restore-drill: --admin-url is required (a maintenance connection, e.g. …/postgres)",
  );
  process.exit(1);
}
const keep = argv.includes("--keep");
const SOURCE_DB = argAfter("--source-db") ?? "kajianq_drill_src";
const TARGET_DB = argAfter("--target-db") ?? "kajianq_drill_dst";
const LABEL = "drill";
const TMP = process.env.TMPDIR ?? "/tmp";
const REPO_DIR = `${TMP}/kajianq-drill-repo-${process.pid}`;
const PASS_FILE = `${TMP}/kajianq-drill-${process.pid}.pass`;

function fail(msg) {
  console.error(`restore-drill: ${msg}`);
  process.exit(1);
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

/** A connection URL for `db` on the same server as `adminUrl`. */
function withDb(url, db) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

function run(cmd, args, env = {}) {
  const res = spawnSync(cmd, args, { env: { ...process.env, ...env }, encoding: "utf8" });
  if (res.error) fail(`${cmd} could not run: ${res.error.message}`);
  if (res.status !== 0) {
    // A child that fails may still have printed a diagnosable report on stdout
    // (the restore script prints its verdict before exiting non-zero), so both
    // streams are surfaced rather than only stderr.
    fail(
      `${cmd} exited ${res.status}\n` +
        `  stdout: ${(res.stdout || "").trim()}\n` +
        `  stderr: ${(res.stderr || "").trim()}`,
    );
  }
  return (res.stdout || "").trim();
}

const psql = (url, statement) =>
  run("psql", ["-At", "-v", "ON_ERROR_STOP=1", "-c", statement], pgEnv(url));
const psqlFile = (url, file) =>
  run("psql", ["-At", "-v", "ON_ERROR_STOP=1", "-f", file], pgEnv(url));

/** Exact row counts, the same shape the manifest records. */
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

const count = (url, table, where = "") =>
  Number(psql(url, `SELECT count(*) FROM ${table} ${where}`));

function dropAndCreate(name) {
  psql(adminUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  psql(adminUrl, `CREATE DATABASE ${name}`);
}

/** Assert an expression, collecting failures instead of throwing on the first. */
function makeChecker() {
  const failures = [];
  const check = (ok, label) => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failures.push(label);
  };
  return { check, failures };
}

// ---------------------------------------------------------------------------
// schema + seed
// ---------------------------------------------------------------------------
dropAndCreate(SOURCE_DB);
dropAndCreate(TARGET_DB);
const sourceUrl = withDb(adminUrl, SOURCE_DB);
const targetUrl = withDb(adminUrl, TARGET_DB);

if (psql(sourceUrl, "SELECT count(*) FROM pg_available_extensions WHERE name='vector'") !== "1") {
  fail(
    "pgvector is not available on this server, so the real engine migration cannot be " +
      "applied. Run the drill against a pgvector-enabled Postgres (CI uses " +
      "pgvector/pgvector:pg18) — the drill deliberately tests the real schema, not a stub.",
  );
}
psqlFile(sourceUrl, MIGRATIONS);
console.log(`restore-drill: applied ${MIGRATIONS.replace(REPO_ROOT, "")} to ${SOURCE_DB}`);

const LIVE = "11111111-1111-4111-8111-111111111111";
const ORPHAN = "22222222-2222-4222-8222-222222222222";
const SUBJECT = "33333333-3333-4333-8333-333333333333";

// A live anonymous user: session in the future, one chat. MUST survive both the
// reclamation and the restore (a session that keeps being used keeps its
// transcript — ADR-0043 decision 4).
psql(
  sourceUrl,
  `INSERT INTO users (id, kind) VALUES ('${LIVE}', 'anonymous');
   INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES
     ('11111111-1111-4111-8111-111111111112', '${LIVE}', 'live-hash', now() + interval '20 days');
   INSERT INTO chat_sessions (id, user_id) VALUES
     ('11111111-1111-4111-8111-111111111113', '${LIVE}');
   INSERT INTO chat_messages (id, session_id, role, content) VALUES
     ('11111111-1111-4111-8111-111111111114', '11111111-1111-4111-8111-111111111113',
      'user', 'live question that must survive');`,
);

// An expired session whose user has no other session: the token row AND the
// user with its chat/trace subtree are what the nightly reclamation removes.
psql(
  sourceUrl,
  `INSERT INTO users (id, kind) VALUES ('${ORPHAN}', 'anonymous');
   INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES
     ('22222222-2222-4222-8222-222222222223', '${ORPHAN}', 'expired-hash', now() - interval '3 days');
   INSERT INTO chat_sessions (id, user_id) VALUES
     ('22222222-2222-4222-8222-222222222224', '${ORPHAN}');
   INSERT INTO chat_messages (id, session_id, role, content) VALUES
     ('22222222-2222-4222-8222-222222222225', '22222222-2222-4222-8222-222222222224',
      'user', 'abandoned question');
   INSERT INTO answer_traces (id, message_id, user_id, trace) VALUES
     ('22222222-2222-4222-8222-222222222226', 'abandoned-message', '${ORPHAN}',
      '{"events":[]}'::jsonb);`,
);

// A subject who exercises Art. 17 after the backup was taken. Trace and
// feedback reference them with ON DELETE CASCADE. The subject holds a LIVE
// session on purpose: the nightly reclamation must not be able to remove them,
// so the "subject is gone" assertion below can only be satisfied by the Art. 17
// erasure path — not by a reclaim that happened to sweep the row anyway.
psql(
  sourceUrl,
  `INSERT INTO users (id, kind) VALUES ('${SUBJECT}', 'anonymous');
   INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES
     ('33333333-3333-4333-8333-333333333337', '${SUBJECT}', 'subject-hash', now() + interval '15 days');
   INSERT INTO chat_sessions (id, user_id) VALUES
     ('33333333-3333-4333-8333-333333333334', '${SUBJECT}');
   INSERT INTO chat_messages (id, session_id, role, content) VALUES
     ('33333333-3333-4333-8333-333333333335', '33333333-3333-4333-8333-333333333334',
      'user', 'erase me after the backup');
   INSERT INTO answer_traces (id, message_id, user_id, trace) VALUES
     ('33333333-3333-4333-8333-333333333336', 'subject-message', '${SUBJECT}',
      '{"events":[]}'::jsonb);
   INSERT INTO feedback (message_id, user_id, rating, anchor_type, free_text) VALUES
     ('subject-message', '${SUBJECT}', -1, 'answer', 'erase me too');`,
);

// ---------------------------------------------------------------------------
// backup — the production script, so the drill exercises the shipped path.
// ---------------------------------------------------------------------------
mkdirSync(REPO_DIR, { recursive: true });
writeFileSync(PASS_FILE, "drill-passphrase\n", { mode: 0o600 });
const backupEnv = {
  PGDATABASE_URL: sourceUrl,
  RESTIC_REPOSITORY: REPO_DIR,
  RESTIC_PASSWORD_FILE: PASS_FILE,
  RESTIC_PASSWORD: "drill-passphrase",
};
// One-time repository creation is a runbook step on the VPS
// (docs/VPS-HARDENING-RUNBOOK.md); the drill does it here so the run is
// self-contained.
run("restic", ["-r", REPO_DIR, "init"], { RESTIC_PASSWORD: "drill-passphrase" });
const backupOut = run("bun", [`${HERE}kajianq-backup.mjs`, "--label", LABEL], backupEnv);
console.log("restore-drill: backup complete");
console.log(
  backupOut
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n"),
);

// ---------------------------------------------------------------------------
// simulate live erasure AFTER the backup (this is what makes the restore
// resurrect data, which is the thing the ADR's clause exists to catch).
// ---------------------------------------------------------------------------
for (const statement of RECLAIM_SQL) psql(sourceUrl, statement);
psql(sourceUrl, erasureSql(SUBJECT));
const liveCounts = tableCounts(sourceUrl);
console.log(`restore-drill: live state after reclamation + Art. 17 erasure (${SOURCE_DB})`);

// ---------------------------------------------------------------------------
// restore into the scratch target — the production script, twice.
//
// Pass 1 uses --skip-erasure so the drill can OBSERVE the resurrected rows (its
// negative control). Pass 2 is the default mode — the exact command the runbook
// tells the owner to run — which re-applies the reclamation and the Art. 17
// erasure. Both passes restore the same snapshot into the same target, so pass
// 2 is a genuine run of the shipped erasure path.
// ---------------------------------------------------------------------------
const restoreOut = run(
  "bun",
  [`${HERE}kajianq-restore.mjs`, "--label", LABEL, "--target-url", targetUrl, "--skip-erasure"],
  backupEnv,
);
console.log("restore-drill: restore complete (pass 1 — erasure skipped, for the negative control)");
console.log(
  restoreOut
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n"),
);

// ---------------------------------------------------------------------------
// assert 1 — the negative control: the restore DID bring the erased data back.
// ---------------------------------------------------------------------------
{
  const { check, failures } = makeChecker();
  console.log("restore-drill: assert 1 — the restore resurrects erased data (negative control)");
  check(
    count(targetUrl, "users", `WHERE id = '${SUBJECT}'`) === 1,
    "restored target holds the erased subject user (proves the backup carried it)",
  );
  check(
    count(targetUrl, "chat_messages", `WHERE id = '33333333-3333-4333-8333-333333333335'`) === 1,
    "restored target holds the erased subject chat",
  );
  check(
    count(targetUrl, "answer_traces", `WHERE id = '33333333-3333-4333-8333-333333333336'`) === 1,
    "restored target holds the erased subject trace",
  );
  check(
    count(targetUrl, "users", `WHERE id = '${ORPHAN}'`) === 1,
    "restored target holds the expired orphan user",
  );
  check(
    count(targetUrl, "sessions", `WHERE expires_at <= now()`) === 1,
    "restored target holds the expired session",
  );
  if (failures.length > 0) {
    fail(
      `negative control failed — the drill is not testing what it claims (${failures.join("; ")})`,
    );
  }
}

// ---------------------------------------------------------------------------
// pass 2 — the production script in its default mode re-applies erasure: the
// reclamation always, plus the Art. 17 cascade for the subject whose request
// arrived after the backup was taken.
// ---------------------------------------------------------------------------
const eraseOut = run(
  "bun",
  [
    `${HERE}kajianq-restore.mjs`,
    "--label",
    LABEL,
    "--target-url",
    targetUrl,
    "--erase-user",
    SUBJECT,
  ],
  backupEnv,
);
console.log("restore-drill: restore complete (pass 2 — production erasure re-applied)");
console.log(
  eraseOut
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n"),
);

// ---------------------------------------------------------------------------
// assert 2 — the target now matches the live store.
// ---------------------------------------------------------------------------
const restoredCounts = tableCounts(targetUrl);

{
  const { check, failures } = makeChecker();
  console.log(
    "restore-drill: assert 2 — erasure re-applied, restored target matches the live store",
  );
  check(count(targetUrl, "users", `WHERE id = '${SUBJECT}'`) === 0, "subject user is gone");
  check(
    count(targetUrl, "chat_messages", `WHERE content = 'erase me after the backup'`) === 0,
    "subject chat is gone (FK cascade reached chat_messages)",
  );
  check(
    count(targetUrl, "answer_traces", `WHERE message_id = 'subject-message'`) === 0,
    "subject trace is gone (FK cascade reached answer_traces)",
  );
  check(
    count(targetUrl, "feedback", `WHERE free_text = 'erase me too'`) === 0,
    "subject feedback is gone (FK cascade reached feedback)",
  );
  check(
    count(targetUrl, "sessions", `WHERE expires_at <= now()`) === 0,
    "expired sessions reclaimed",
  );
  check(
    count(targetUrl, "users", `WHERE id = '${ORPHAN}'`) === 0,
    "orphaned anonymous user reclaimed (cascade removed its subtree)",
  );
  check(
    count(targetUrl, "users", `WHERE id = '${LIVE}'`) === 1 &&
      count(targetUrl, "sessions", `WHERE user_id = '${LIVE}'`) === 1,
    "the live user and its session survive the reclaim",
  );
  check(
    count(targetUrl, "chat_messages", `WHERE content = 'live question that must survive'`) === 1,
    "the live user's chat survives (a used session keeps its transcript)",
  );

  // The whole personal-data subtree must agree with the live store, not just
  // the rows this drill names by hand.
  for (const table of ["users", "sessions", "chat_sessions", "chat_messages", "answer_traces"]) {
    check(
      restoredCounts[table] === liveCounts[table],
      `${table} matches the live store (restored=${restoredCounts[table]} live=${liveCounts[table]})`,
    );
  }

  if (failures.length > 0) fail(`assertions failed: ${failures.join("; ")}`);
}

// ---------------------------------------------------------------------------
// cleanup — the scratch databases and plaintext never outlive the drill.
// ---------------------------------------------------------------------------
if (!keep) {
  psql(adminUrl, `DROP DATABASE IF EXISTS ${SOURCE_DB} WITH (FORCE)`);
  psql(adminUrl, `DROP DATABASE IF EXISTS ${TARGET_DB} WITH (FORCE)`);
  rmSync(REPO_DIR, { recursive: true, force: true });
  rmSync(PASS_FILE, { force: true });
}
console.log(
  `restore-drill: OK — encrypted backup restored into a scratch location and erasure re-applied`,
);
