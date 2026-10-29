import { describe, expect, it, vi } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripTxnMarkers } from "../../packages/infra/scripts/migration-sql.mjs";
import { parseArgs, status, statusLines } from "../../packages/infra/scripts/db-migrate.mjs";

/**
 * Regression tests for the migration runner's transaction-marker stripping.
 *
 * The original implementation dropped every line that was exactly
 * `BEGIN`/`COMMIT` (case-insensitive). That also matched the bare `BEGIN` of a
 * PL/pgSQL block inside a `DO $$ … $$` body, leaving the dollar-quoted body
 * without its block opener — Postgres then failed the whole migration with
 * `syntax error at or near "IF"`. It went unnoticed because
 * `0002_aligned_pairs.sql` is the first migration to use a `DO` block, and it
 * had never been applied to a real database until the staging corpus ingest.
 */

const WRAPPED = `-- a migration
BEGIN;

CREATE TABLE t (id int);

COMMIT;
`;

describe("stripTxnMarkers — file-level wrapper only", () => {
  it("removes a leading BEGIN; and a trailing COMMIT;", () => {
    const out = stripTxnMarkers(WRAPPED);
    expect(out).not.toMatch(/^\s*BEGIN\s*;\s*$/m);
    expect(out).not.toMatch(/^\s*COMMIT\s*;\s*$/m);
    expect(out).toContain("CREATE TABLE t (id int);");
  });

  it("keeps a PL/pgSQL BEGIN inside a dollar-quoted DO block", () => {
    const sql = `BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables) THEN
    RETURN;
  END IF;
END $$;

COMMIT;
`;
    const out = stripTxnMarkers(sql);
    // The file-level wrapper is gone…
    expect(out).not.toMatch(/^\s*BEGIN\s*;\s*$/m);
    expect(out).not.toMatch(/^\s*COMMIT\s*;\s*$/m);
    // …but the block's own BEGIN, its IF, and its END survive intact.
    expect(out).toMatch(/^\s*BEGIN\s*$/m);
    expect(out).toContain("IF EXISTS (SELECT 1 FROM information_schema.tables)");
    expect(out).toContain("END $$;");
  });

  it("keeps a dollar-quoted block that is the file's first statement (no wrapper)", () => {
    const sql = `DO $$
BEGIN
  IF EXISTS (SELECT 1) THEN
    RETURN;
  END IF;
END $$;
`;
    const out = stripTxnMarkers(sql);
    expect(out).toMatch(/^\s*BEGIN\s*$/m);
    expect(out).toContain("IF EXISTS (SELECT 1)");
  });

  it("leaves an unwrapped file untouched", () => {
    const sql = `CREATE TABLE t (id int);\nCREATE INDEX t_id ON t (id);\n`;
    expect(stripTxnMarkers(sql)).toBe(sql);
  });

  it("ignores blank and comment-only lines when locating the wrapper", () => {
    const sql = `-- header\n--\n\nBEGIN;\nSELECT 1;\n\n-- footer\nCOMMIT;\n`;
    const out = stripTxnMarkers(sql);
    expect(out).toContain("-- header");
    expect(out).toContain("-- footer");
    expect(out).not.toMatch(/^\s*BEGIN\s*;\s*$/m);
    expect(out).not.toMatch(/^\s*COMMIT\s*;\s*$/m);
  });

  it("strips the real 0002_aligned_pairs.sql wrapper without touching its DO block", () => {
    const path = resolve(
      process.cwd(),
      "packages/kajianq-domain/migrations/0002_aligned_pairs.sql",
    );
    const out = stripTxnMarkers(readFileSync(path, "utf8"));
    expect(out).not.toMatch(/^\s*BEGIN\s*;\s*$/m);
    expect(out).not.toMatch(/^\s*COMMIT\s*;\s*$/m);
    expect(out).toContain("DO $$");
    expect(out).toMatch(/^\s*BEGIN\s*$/m);
    expect(out).toContain("ADD CONSTRAINT lemma_evidence_ayah_pair_fk");
    expect(out).toContain("END $$;");
  });
});

describe("db-migrate status — the machine report the deploy preflight parses", () => {
  // The preflight (provision/vps/deploy/migration-check.sh) reads this report
  // instead of the human listing, so its shape is a contract between two
  // processes. These rows are the producer side of it: a changed key, order or
  // line shape must redden here (and at the parser) rather than make the gate
  // find no pending migrations and go green.

  it("prints one JSON object with the applied/pending split", () => {
    const lines = statusLines(
      ["0001_init.sql", "0003_feedback_dedup.sql"],
      new Set(["0001_init.sql"]),
      { json: true },
    );
    expect(lines).toEqual(['{"applied":["0001_init.sql"],"pending":["0003_feedback_dedup.sql"]}']);
    expect(JSON.parse(lines[0])).toEqual({
      applied: ["0001_init.sql"],
      pending: ["0003_feedback_dedup.sql"],
    });
  });

  it("keeps the human listing the operator commands print", () => {
    expect(
      statusLines(["0001_init.sql", "0003_feedback_dedup.sql"], new Set(["0001_init.sql"])),
    ).toEqual(["applied   0001_init.sql", "pending   0003_feedback_dedup.sql"]);
  });

  it("accepts --json for status only", () => {
    expect(parseArgs(["bun", "db-migrate.mjs", "status", "--json"]).json).toBe(true);
    expect(parseArgs(["bun", "db-migrate.mjs", "status"]).json).toBe(false);
  });

  it("threads --json into the report the CLI prints", async () => {
    // The flag must reach the formatter: a status() that ignores it would print
    // the human listing, which the preflight refuses.
    const logged = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => logged.push(line));
    try {
      const client = {
        query: async (sql) =>
          sql.includes("SELECT name FROM schema_migrations")
            ? { rows: [{ name: "0001_init.sql" }] }
            : { rows: [] },
      };
      await status(client, { json: true });
    } finally {
      log.mockRestore();
    }
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]).applied).toContain("0001_init.sql");
    expect(JSON.parse(logged[0]).pending.length).toBeGreaterThan(0);
  });
});
