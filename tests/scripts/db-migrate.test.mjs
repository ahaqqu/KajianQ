import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripTxnMarkers } from "../../packages/infra/scripts/migration-sql.mjs";

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
