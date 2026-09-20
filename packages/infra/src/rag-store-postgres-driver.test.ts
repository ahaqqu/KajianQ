import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { postgresSqlRunner } from "./rag-store-postgres-driver";

/**
 * The Postgres driver adapter (#181, ADR-0044). Two properties are load-bearing
 * and cannot be checked against a live server in the default gate job:
 *
 *   1. The tagged-template result is LAZY — handing it to `transaction` must
 *      not have executed it, or a batched write would run its statements on
 *      separate pooled connections outside any transaction.
 *   2. `transaction` runs every statement on ONE connection inside
 *      BEGIN/COMMIT, rolls back on failure, and releases the client either way.
 *
 * A fake pool records exactly which connection ran what, so both are asserted
 * directly.
 */

type Call = { connection: string; text: string; values: unknown[] };

function makeFakePool() {
  const calls: Call[] = [];
  const client = {
    query: (text: string, values?: unknown[]) => {
      calls.push({ connection: "client", text, values: values ?? [] });
      return Promise.resolve({ rows: [] });
    },
    release: vi.fn(),
  };
  const pool = {
    query: (text: string, values?: unknown[]) => {
      calls.push({ connection: "pool", text, values: values ?? [] });
      return Promise.resolve({ rows: [{ id: "pool-row" }] });
    },
    connect: vi.fn(() => Promise.resolve(client)),
  };
  return { pool: pool as unknown as Pool, calls, client };
}

describe("postgresSqlRunner", () => {
  it("does not execute a tagged-template statement until something consumes it", async () => {
    const { pool, calls } = makeFakePool();
    const sql = postgresSqlRunner(pool);
    // Build the statement but hand it to transaction — the construction itself
    // must not have run anything, because transaction is what runs it inside
    // BEGIN/COMMIT on a single connection.
    const a = sql`INSERT INTO t (x) VALUES (${1})`;
    expect(calls).toHaveLength(0);
    await sql.transaction([a]);
    expect(calls.map((c) => c.text)).toEqual(["BEGIN", "INSERT INTO t (x) VALUES ($1)", "COMMIT"]);
    expect(calls.every((c) => c.connection === "client")).toBe(true);
  });

  it("numbers placeholders correctly across multiple interpolations", async () => {
    const { pool, calls } = makeFakePool();
    const sql = postgresSqlRunner(pool);
    const query = sql`SELECT * FROM t WHERE a = ${"x"} AND b = ${2} AND c = ${null}`;
    await sql.transaction([query]);
    const statement = calls.find((c) => c.text.startsWith("SELECT"))!;
    expect(statement.text).toBe("SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3");
    expect(statement.values).toEqual(["x", 2, null]);
  });

  it("leaves a statement with no interpolation untouched (no stray placeholder)", async () => {
    const { pool, calls } = makeFakePool();
    const sql = postgresSqlRunner(pool);
    await sql.transaction([sql`SELECT 1`]);
    expect(calls.map((c) => c.text)).toContain("SELECT 1");
  });

  it("runs transaction statements on one connection, in order, and releases it", async () => {
    const { pool, calls, client } = makeFakePool();
    const sql = postgresSqlRunner(pool);
    const results = await sql.transaction([
      sql`DELETE FROM sessions WHERE expires_at <= ${"t"}`,
      sql`DELETE FROM users WHERE kind = 'anonymous' RETURNING id`,
    ]);
    expect((pool as unknown as { connect: () => unknown }).connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.text)).toEqual([
      "BEGIN",
      "DELETE FROM sessions WHERE expires_at <= $1",
      "DELETE FROM users WHERE kind = 'anonymous' RETURNING id",
      "COMMIT",
    ]);
    // One result per statement, in order — the shape cleanupExpiredSessions
    // reads (results[1] is the user reclamation).
    expect(results).toHaveLength(2);
  });

  it("rolls back and still releases the client when a statement fails", async () => {
    const { pool, calls, client } = makeFakePool();
    client.query = (text: string, values?: unknown[]) => {
      calls.push({ connection: "client", text, values: values ?? [] });
      if (text.startsWith("INSERT")) return Promise.reject(new Error("boom"));
      return Promise.resolve({ rows: [] });
    };
    const sql = postgresSqlRunner(pool);
    await expect(sql.transaction([sql`INSERT INTO t (x) VALUES (${1})`])).rejects.toThrow("boom");
    expect(calls.map((c) => c.text)).toEqual([
      "BEGIN",
      "INSERT INTO t (x) VALUES ($1)",
      "ROLLBACK",
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("refuses a statement that did not come from this runner, rather than running it outside a transaction", async () => {
    const { pool } = makeFakePool();
    const sql = postgresSqlRunner(pool);
    await expect(sql.transaction([Promise.resolve([])])).rejects.toThrow(
      /expects statements from this runner/,
    );
  });

  it("query(text, params) runs on the pool and returns its rows", async () => {
    const { pool, calls } = makeFakePool();
    const sql = postgresSqlRunner(pool);
    const rows = await sql.query("SELECT $1::text AS id", ["a"]);
    expect(rows).toEqual([{ id: "pool-row" }]);
    expect(calls).toEqual([{ connection: "pool", text: "SELECT $1::text AS id", values: ["a"] }]);
  });

  it("a tagged statement run standalone (not batched) executes exactly once", async () => {
    const { pool, calls } = makeFakePool();
    const sql = postgresSqlRunner(pool);
    const rows = await sql`SELECT 1`;
    expect(rows).toEqual([{ id: "pool-row" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.connection).toBe("pool");
  });
});
