import { describe, expect, it } from "vite-plus/test";
import { Effect, Exit } from "effect";
import type { StoreError } from "@app/rag-core";
import { runFail } from "@app/rag-core/testing";
import { createPostgresRagStore, type SqlRunner } from "./rag-store-postgres";
import { sqlEffect } from "./rag-store-postgres-errors";
import { ERASURE_SUBJECT_SETTING } from "./rag-store-postgres-erasure";
import { createRagStore } from "./rag-store-factory";
import type { Logger, LogFields } from "./logger";
import type { Trace } from "@app/contracts";

/**
 * Unit tests for the Postgres RagStore adapter using a fake `SqlRunner`: they run
 * in every environment (no database) and give the adapter's logic — SQL
 * construction, embedding validation, upsert fallback, transaction wiring, row
 * mapping — coverage the secret-gated contract suite cannot provide in the
 * default gate job. The fake records what the adapter asked the driver to do and
 * feeds back canned rows; failures are asserted as `StoreError` kind + cause.
 */

const runOk = <A>(effect: Effect.Effect<A, StoreError>): Promise<A> => Effect.runPromise(effect);

type Recorded = { kind: string; text: string; values: unknown[]; queries?: unknown[] };

function makeFakeSql() {
  const calls: Recorded[] = [];
  let tagReturn: unknown[] = [];
  let queryReturn: unknown[] = [];
  let transactionReturn: unknown[][] = [];
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ kind: "tag", text: strings.join("?"), values });
      return Promise.resolve(tagReturn);
    },
    {
      query: (text: string, values?: unknown[]) => {
        calls.push({ kind: "query", text, values: values ?? [] });
        return Promise.resolve(queryReturn);
      },
      transaction: (queries: unknown[]) => {
        calls.push({ kind: "transaction", text: "", values: [], queries });
        return Promise.resolve(transactionReturn);
      },
    },
  ) as SqlRunner & {
    _calls: Recorded[];
    _setTag(r: unknown[]): void;
    _setQuery(r: unknown[]): void;
    _setTxn(r: unknown[][]): void;
  };
  sql._calls = calls;
  sql._setTag = (r) => {
    tagReturn = r;
  };
  sql._setQuery = (r) => {
    queryReturn = r;
  };
  sql._setTxn = (r) => {
    transactionReturn = r;
  };
  return sql;
}

function makeBoomSql(error: () => unknown): SqlRunner {
  const boom = Object.assign(() => Promise.reject(error()), {
    query: () => Promise.reject(error()),
    transaction: () => Promise.reject(error()),
  }) as SqlRunner;
  return boom;
}

const VEC1536 = Array.from({ length: 1536 }, (_, i) => Math.sin(i * 0.01));

function makeFakeLogger() {
  const calls: {
    level: string;
    msg: string;
    fields?: LogFields | undefined;
  }[] = [];
  const logger: Logger = {
    child: () => logger,
    debug: (msg, fields) => calls.push({ level: "debug", msg, fields }),
    info: (msg, fields) => calls.push({ level: "info", msg, fields }),
    warn: (msg, fields) => calls.push({ level: "warn", msg, fields }),
    error: (msg, fields) => calls.push({ level: "error", msg, fields }),
  };
  return { logger, calls };
}

/** The insert→read fixture: one of every shape the adapter must round-trip,
 * including the `scope_expansion` event variant and an `origin`-bearing chunk
 * ref, exercised through `insertAnswerTrace` and read back. */
const sampleTrace: Trace = {
  id: "t1",
  version: 1,
  createdAt: 1,
  events: [
    {
      stage: "retriever",
      kind: "retrieval",
      detail: {
        chunks: [
          { id: "c1", score: 0.5, rankDense: 1, rankSparse: 2 },
          { id: "c2", origin: "expansion" },
        ],
      },
      at: 1,
    },
    {
      stage: "retriever",
      kind: "scope_expansion",
      detail: { key: "reference", value: "1", returned: 1, cap: 12, truncated: false },
      at: 1,
    },
    { stage: "generator", kind: "llm_call", at: 1 },
  ],
};

describe("rag-store-postgres adapter (fake runner)", () => {
  it("insertDocParent upserts and returns the RETURNING id, falling back to the generated id", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setTag([{ id: "from-db" }]);
    const id = await runOk(
      store.insertDocParent({ sourceKey: "k", title: "t", metadata: { a: 1 } }),
    );
    expect(id).toBe("from-db");
    expect(sql._calls[0]?.text).toContain("INSERT INTO doc_parents");
    expect(sql._calls[0]?.text).toContain("ON CONFLICT (source_key) DO UPDATE");

    // No RETURNING row → fall back to the caller-supplied/generated id.
    sql._setTag([]);
    const id2 = await runOk(store.insertDocParent({ sourceKey: "k2", title: null, metadata: {} }));
    expect(typeof id2).toBe("string");
  });

  it("insertDocChild upserts by (parent_id, ordinal) without overwriting text_raw", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setQuery([{ id: "child-1" }]);
    const id = await runOk(
      store.insertDocChild({
        parentId: "p",
        textRaw: "raw",
        textAr: "ar",
        textId: "id",
        embeddingPrimary: VEC1536,
        embeddingFallback: null,
        ordinal: 0,
        metadata: {},
      }),
    );
    expect(id).toBe("child-1");
    const text = sql._calls[0]?.text ?? "";
    expect(text).toContain("INSERT INTO doc_children");
    expect(text).toContain("embedding_primary, embedding_fallback");
    expect(text).toContain("ON CONFLICT (parent_id, ordinal) DO UPDATE");
    // text_raw must not be in the UPDATE set: it is immutable.
    expect(text).not.toMatch(/SET[^]*text_raw\s*=/);
  });

  it("insertDocChildren batches rows in a single query", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setQuery([{ id: "c1" }, { id: "c2" }]);
    const ids = await runOk(
      store.insertDocChildren([
        {
          parentId: "p",
          textRaw: "raw-1",
          textAr: "ar-1",
          textId: "id-1",
          embeddingPrimary: VEC1536,
          embeddingFallback: null,
          ordinal: 0,
          metadata: {},
        },
        {
          parentId: "p",
          textRaw: "raw-2",
          textAr: "ar-2",
          textId: "id-2",
          embeddingPrimary: VEC1536,
          embeddingFallback: null,
          ordinal: 1,
          metadata: {},
        },
      ]),
    );
    expect(ids).toEqual(["c1", "c2"]);
    expect(sql._calls).toHaveLength(1);
    const batchText = sql._calls[0]?.text ?? "";
    const batchValues = sql._calls[0]?.values ?? [];
    expect(batchValues).toHaveLength(20);
    // Every placeholder must be distinct, contiguous ($1..$20) and bound to the
    // right value; the id slot is first in each row.
    const placeholders = [...batchText.matchAll(/\$\d+/g)].map((m) => m[0]);
    expect(placeholders).toHaveLength(20);
    expect(placeholders.map((p) => Number(p.slice(1)))).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(typeof batchValues[0]).toBe("string");
    expect(batchValues[1]).toBe("p");
    expect(batchValues[2]).toBe("raw-1");
    expect(batchValues[3]).toBe("ar-1");
    expect(typeof batchValues[10]).toBe("string");
    expect(batchValues[11]).toBe("p");
    expect(batchValues[12]).toBe("raw-2");
    // JSON columns are cast in the SQL text, never inside a bound value.
    expect(batchText).toContain("::jsonb");
    for (const value of batchValues) {
      expect(typeof value !== "string" || !value.endsWith("::jsonb")).toBe(true);
    }
    // text_raw must not be in the UPDATE set: it is immutable.
    expect(batchText).not.toMatch(/SET[^]*text_raw\s*=/);
  });

  it("insertDocChild rejects wrong-dimension embeddings before touching the DB (constraint kind)", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    const err = await runFail(
      store.insertDocChild({
        parentId: "p",
        textRaw: "raw",
        textAr: "ar",
        textId: null,
        embeddingPrimary: [0.1, 0.2],
        embeddingFallback: null,
        ordinal: 0,
        metadata: {},
      }),
    );
    // Taxonomy: a bad vector is constraint-class, cause wraps the original.
    expect(err.kind).toBe("constraint");
    expect((err.cause as Error).message).toMatch(/dimension mismatch/);
    expect(sql._calls).toHaveLength(0);
  });

  it("similaritySearch validates the embedding, builds bound params, and maps rows", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setQuery([
      {
        id: "c1",
        parent_id: "p1",
        text_raw: "raw",
        text_ar: "ar",
        text_id: "id",
        citation: { s: 2 },
        embedding_primary: null,
        embedding_fallback: null,
        ordinal: 3,
        metadata: { pfx: "x" },
        created_at: "2023-11-14T22:13:20.000Z",
        distance: 0.25,
        rank_dense: 1,
      },
    ]);
    const hits = await runOk(
      store.similaritySearch("primary", VEC1536, {
        limit: 5,
        filters: { pfx: "x", kind: ["a", "b"] },
      }),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.child.id).toBe("c1");
    expect(hits[0]?.distance).toBe(0.25);
    expect(hits[0]?.rankDense).toBe(1);
    expect(hits[0]?.child.embeddingPrimary).toBeNull();
    expect(hits[0]?.child.embeddingFallback).toBeNull();
    const q = sql._calls.find((c) => c.kind === "query");
    expect(q?.text).toContain("embedding_primary <=> $1::vector");
    expect(q?.text).toContain("NULL::text AS embedding_primary");
    expect(q?.values).toHaveLength(6);
  });

  it("similaritySearch rejects a bad-dimension embedding before querying (constraint kind)", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    const err = await runFail(store.similaritySearch("primary", [0.1], { limit: 5 }));
    expect(err.kind).toBe("constraint");
    expect((err.cause as Error).message).toMatch(/dimension mismatch/);
    expect(sql._calls.find((c) => c.kind === "query")).toBeUndefined();
  });

  it("similaritySearch fails constraint-class on a corrupt stored vector", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setQuery([
      {
        id: "c1",
        parent_id: "p1",
        text_raw: "raw",
        text_ar: "ar",
        text_id: "id",
        citation: { s: 2 },
        embedding_primary: "[1,abc]",
        embedding_fallback: null,
        ordinal: 3,
        metadata: {},
        created_at: "2023-11-14T22:13:20.000Z",
        distance: 0.25,
        rank_dense: 1,
      },
    ]);
    const err = await runFail(store.similaritySearch("primary", VEC1536, { limit: 5 }));
    expect(err.kind).toBe("constraint");
    expect((err.cause as Error).message).toMatch(/unexpected vector component/);
  });

  it("insertAnswerTrace validates the Trace and stores user_id", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    const id = await runOk(
      store.insertAnswerTrace({ messageId: "m1", userId: "u1", trace: sampleTrace }),
    );
    const text = sql._calls[0]?.text ?? "";
    expect(text).toContain("INSERT INTO answer_traces");
    expect(text).toContain("user_id");
    expect(sql._calls[0]?.values).toContain("u1");
    // The returned id must be the id actually inserted: it need not equal
    // `trace.id`, and callers persist dependent rows against the returned one.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(sql._calls[0]?.values?.[0]).toBe(id);
    // The scope-expansion kind and the origin label persist verbatim.
    const persisted = String(sql._calls[0]?.values?.[3] ?? "");
    expect(persisted).toContain('"scope_expansion"');
    expect(persisted).toContain('"origin":"expansion"');
  });

  it("insertAnswerTrace fails constraint-class on a malformed Trace", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    const err = await runFail(
      store.insertAnswerTrace({
        messageId: "m1",
        userId: "u1",
        // Missing required trace fields — contract rejection.
        trace: { events: "not-an-array" } as unknown as Trace,
      }),
    );
    expect(err.kind).toBe("constraint");
    expect(sql._calls).toHaveLength(0);
  });

  it("getAnswerTraceByMessage returns null when absent and the parsed Trace when present", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setTag([]);
    expect(await runOk(store.getAnswerTraceByMessage("none"))).toBeNull();
    sql._setTag([{ trace: sampleTrace }]);
    const got = await runOk(store.getAnswerTraceByMessage("m1"));
    expect(got).toEqual(sampleTrace);
    expect(sql._calls[0]?.text).toContain("SELECT trace FROM answer_traces");
    const scope = got?.events.find((e) => e.kind === "scope_expansion");
    expect(scope?.kind === "scope_expansion" ? scope.detail : undefined).toEqual({
      key: "reference",
      value: "1",
      returned: 1,
      cap: 12,
      truncated: false,
    });
    const retrieval = got?.events.find((e) => e.kind === "retrieval");
    const refs = retrieval?.kind === "retrieval" ? retrieval.detail.chunks : [];
    expect(refs.map((ref) => ref.origin)).toEqual([undefined, "expansion"]);
  });

  it("getAnswerTraceByMessage fails constraint-class on a corrupt persisted trace", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setTag([{ trace: { id: 42 } }]);
    const err = await runFail(store.getAnswerTraceByMessage("m1"));
    expect(err.kind).toBe("constraint");
  });

  it("createChatSession and insertChatMessage issue the right inserts", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    await runOk(store.createChatSession({ userId: "u1", metadata: { k: 1 } }));
    expect(sql._calls[0]?.text).toContain("INSERT INTO chat_sessions");
    await runOk(store.insertChatMessage({ sessionId: "s1", role: "user", content: "hi" }));
    expect(sql._calls[1]?.text).toContain("INSERT INTO chat_messages");
  });

  it("createSession writes users + sessions in one atomic transaction", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    const out = await runOk(store.createSession());
    expect(out.userId).toEqual(expect.any(String));
    expect(out.token.length).toBeGreaterThanOrEqual(40);
    expect(out.expiresAt).toBeGreaterThan(Date.now() - 1000);
    // The adapter evaluates the two INSERTs (tagged calls) then hands their
    // promises to sql.transaction, so the call order is: tag, tag, transaction.
    const tags = sql._calls.filter((c) => c.kind === "tag");
    expect(tags).toHaveLength(2);
    expect(tags[0]?.text).toContain("INSERT INTO users");
    expect(tags[1]?.text).toContain("INSERT INTO sessions");
    const tx = sql._calls.find((c) => c.kind === "transaction");
    expect(tx).toBeDefined();
    expect(tx?.queries).toHaveLength(2);
  });

  it("resolveUserId returns the user_id for a live session and null otherwise", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setTag([{ user_id: "u1" }]);
    expect(await runOk(store.resolveUserId("tok"))).toBe("u1");
    sql._setTag([]);
    expect(await runOk(store.resolveUserId("tok"))).toBeNull();
    expect(sql._calls[0]?.text).toContain("expires_at > now()");
  });

  it("cleanupExpiredSessions reclaims expired sessions AND orphaned users (A5)", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setTxn([
      [{ id: "a" }, { id: "b" }],
      [{ id: "u1" }, { id: "u2" }, { id: "u3" }],
    ]);
    const n = await runOk(store.cleanupExpiredSessions());
    expect(n).toBe(3);
    const tx = sql._calls.find((c) => c.kind === "transaction");
    expect(tx?.queries).toHaveLength(2);
    const statements = sql._calls.filter((c) => c.kind === "tag").map((c) => c.text);
    expect(statements[0]).toContain("DELETE FROM sessions WHERE expires_at <=");
    // The orphan reclamation is the second statement and must never touch a live user.
    expect(statements[1]).toContain("DELETE FROM users");
    expect(statements[1]).toContain("kind = 'anonymous'");
    expect(statements[1]).toContain("NOT EXISTS (SELECT 1 FROM sessions");
  });

  it("deleteUserCascade erases in one transaction whose postcondition runs inside it", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    await runOk(store.deleteUserCascade("u1"));

    // One batch call, never a sequence of standalone statements: the postcondition
    // statements share the transaction, so a surviving row rolls the whole subtree
    // back instead of committing over it.
    expect(sql._calls.filter((c) => c.kind === "transaction")).toHaveLength(1);
    const statements = sql._calls.filter((c) => c.kind === "tag");
    const text = statements.map((c) => c.text);

    // The subject id is bound once and the assertions read it back: a DO block
    // cannot take parameters, so every occurrence has to name the same setting.
    expect(statements[0]?.values).toEqual(["kajianq.erasure.subject", "u1"]);
    const settings = new Set(
      [...text.join("\n").matchAll(/'kajianq\.erasure\.[a-z_]+'/g)].map((m) => m[0]),
    );
    expect([...settings]).toEqual([`'${ERASURE_SUBJECT_SETTING}'`]);

    // Each child table is named explicitly, so the erasure does not depend on the
    // FK cascade alone; chat messages are swept through the user's sessions while
    // those sessions still exist.
    expect(text[1]).toContain("DELETE FROM chat_messages");
    expect(text[1]).toContain("SELECT id FROM chat_sessions WHERE user_id");
    expect(text[3]).toContain("DELETE FROM feedback WHERE user_id");
    expect(text[4]).toContain("DELETE FROM answer_traces WHERE user_id");
    expect(text[5]).toContain("DELETE FROM chat_sessions WHERE user_id");
    expect(text[6]).toContain("DELETE FROM sessions WHERE user_id");
    // The parent delete is last: its FK cascade is the backstop for anything
    // committed between a sweep and this statement.
    expect(text[7]).toContain("DELETE FROM users WHERE id");

    // The message sweep is verified before the chat sessions go — the only point
    // where a message can still be attributed to the user — and the remaining
    // tables are verified after the parent delete.
    expect(text[2]).toContain("DO $$");
    expect(text[2]).toContain("'chat_messages' AS verified_table");
    expect(text[2]).toContain("ERRCODE = '23514'");
    expect(text[8]).toContain("DO $$");
    expect(text[8]).toContain("ERRCODE = '23514'");
  });

  it("every swept table is verified, and every verified table is swept", async () => {
    const sql = makeFakeSql();
    await runOk(createPostgresRagStore(sql).deleteUserCascade("u1"));
    const text = sql._calls
      .filter((c) => c.kind === "tag")
      .map((c) => c.text)
      .join("\n");
    const swept = new Set([...text.matchAll(/DELETE FROM ([a-z_]+)/g)].map((m) => m[1]!));
    const verified = new Set(
      [...text.matchAll(/SELECT '([a-z_]+)' AS verified_table/g)].map((m) => m[1]!),
    );
    // The contract suite pins this set against the schema's cascading closure; here
    // the pin is that a table cannot be swept without being verified, or verified
    // without being swept.
    expect([...verified].sort()).toEqual([...swept].sort());
  });

  it("deleteUserCascade reports a surviving row as a constraint error naming it", async () => {
    const sql = makeFakeSql();
    // The postcondition raised inside the transaction: the driver rolled back and
    // rejected with the server error, so the caller sees the typed failure.
    sql.transaction = () =>
      Promise.reject(
        Object.assign(new Error("user erasure left rows behind in: chat_sessions"), {
          severity: "ERROR",
          code: "23514",
        }),
      );
    const err = await runFail(createPostgresRagStore(sql).deleteUserCascade("u1"));
    expect(err.kind).toBe("constraint");
    expect(String(err.cause)).toContain("chat_sessions");
  });

  it("deleteUserCascade is idempotent on an already-empty subtree", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    await runOk(store.deleteUserCascade("u1"));
    await runOk(store.deleteUserCascade("u1"));
    // An empty subtree is a no-op success: the deletes remove nothing and every
    // postcondition statement passes.
    expect(sql._calls.filter((c) => c.kind === "transaction")).toHaveLength(2);
  });

  it("deleteUserCascade surfaces a failing statement as a StoreError (the batch rolls back)", async () => {
    const sql = makeFakeSql();
    // The driver's batch primitive rejects when a statement fails (after its own
    // ROLLBACK); the fake's tag calls stay resolved, so only the batch rejects —
    // the shape a real mid-batch failure has.
    sql.transaction = () =>
      Promise.reject(
        Object.assign(new Error("could not serialize access"), {
          severity: "ERROR",
          code: "40001",
        }),
      );
    const store = createPostgresRagStore(sql);
    const err = await runFail(store.deleteUserCascade("u1"));
    expect(err.kind).toBe("transport");
  });

  it("classifies a Postgres unique violation as constraint (taxonomy, ADR-0027 d7)", async () => {
    const sql = makeBoomSql(() =>
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        severity: "ERROR",
        code: "23505",
      }),
    );
    const store = createPostgresRagStore(sql);
    const err = await runFail(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    expect(err.kind).toBe("constraint");
    expect((err.cause as { code?: string }).code).toBe("23505");
  });

  it("classifies an auth failure (28P01) as config, not transport", async () => {
    const sql = makeBoomSql(() =>
      Object.assign(new Error("authentication failed"), {
        severity: "FATAL",
        code: "28P01",
      }),
    );
    const store = createPostgresRagStore(sql);
    const err = await runFail(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    expect(err.kind).toBe("config");
  });

  it("classifies a refused connection as config (wrong host/port, not a blip)", async () => {
    // node-postgres surfaces a Node errno error here: `code` is ECONNREFUSED
    // and there is no `severity`, so it must not reach the SQLSTATE table.
    const sql = makeBoomSql(() =>
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
        code: "ECONNREFUSED",
      }),
    );
    const store = createPostgresRagStore(sql);
    const err = await runFail(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    expect(err.kind).toBe("config");
  });

  it("classifies a driver timeout message as timeout", async () => {
    const sql = makeBoomSql(() => new Error("connection timed out"));
    const store = createPostgresRagStore(sql);
    const err = await runFail(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    expect(err.kind).toBe("timeout");
  });

  it("classifies an unknown network failure as transport (closed default)", async () => {
    const sql = makeBoomSql(() => new Error("Connection terminated unexpectedly"));
    const store = createPostgresRagStore(sql);
    const err = await runFail(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    expect(err.kind).toBe("transport");
  });

  it("classifies schema drift (42703/42P01) as config, not constraint", async () => {
    for (const code of ["42703", "42P01"]) {
      const sql = makeBoomSql(() =>
        Object.assign(new Error(`column "x" does not exist`), {
          severity: "ERROR",
          code,
        }),
      );
      const store = createPostgresRagStore(sql);
      const err = await runFail(
        store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }),
      );
      expect(err.kind).toBe("config");
    }
  });

  it("does not SQLSTATE-classify non-Postgres errors that carry a string code (B1 guard)", async () => {
    // A Node-style ErrnoException carries `code: string` but no `severity`: it
    // is NOT a Postgres server error, so it falls to the closed transport default.
    const sql = makeBoomSql(() =>
      Object.assign(new Error("something went wrong"), {
        code: "23505", // collides with unique_violation on purpose
      }),
    );
    const store = createPostgresRagStore(sql);
    const err = await runFail(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    expect(err.kind).toBe("transport");
  });
});

describe("sqlEffect execution-semantics guard (A1)", () => {
  it("executes a lazy thenable exactly once while the guard still observes rejections", async () => {
    // Simulates the driver's lazy query promise, where every consumer fires a
    // fresh execution: the guard must adopt it with exactly one execution — never
    // attach a second consumer to the lazy promise.
    let executions = 0;
    class LazyThenable {
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        executions += 1;
        return Promise.resolve([]).then(onF, onR);
      }
    }
    const sql = (() => new LazyThenable()) as unknown as SqlRunner;
    await runOk(sqlEffect(sql, (s) => (s as unknown as (s2: SqlRunner) => Promise<unknown>)(s)));
    expect(executions).toBe(1);
  });

  it("retires a rejection that settles after the awaiting fiber is gone (no unhandled rejection)", async () => {
    let settled = false;
    class LazyThenable {
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        void new Promise((_res, rej) =>
          setTimeout(() => {
            settled = true;
            rej(new Error("late rejection"));
          }, 20),
        ).then(onF, onR);
        return Promise.resolve([]);
      }
    }
    const sql = (() => new LazyThenable()) as unknown as SqlRunner;
    const eff = sqlEffect(sql, (s) => (s as unknown as (s2: SqlRunner) => Promise<unknown>)(s));
    const abandoned = Effect.runPromise(eff).then(
      () => "ok",
      () => "failed",
    );
    // The awaiting fiber sees the immediate success path; the late rejection
    // is observed by the interruption guard, not as an unhandled rejection.
    expect(await abandoned).toBe("failed");
    await new Promise((r) => setTimeout(r, 60));
    expect(settled).toBe(true);
  });
});

describe("rag-store-postgres adapter: optional ops logging", () => {
  it("propagates the original as cause, classified transport, when no logger is configured", async () => {
    const store = createPostgresRagStore(makeBoomSql(() => new Error("db down")));
    const err = await runFail(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    // A generic Error carries no SQLSTATE/shape → transport (closed default).
    expect(err.kind).toBe("transport");
    expect((err.cause as Error).message).toBe("db down");
  });

  it("warns on slow queries with only {op, ms} fields, no SQL text or values", async () => {
    const fake = makeFakeLogger();
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql, {
      logger: fake.logger,
      slowQueryMs: 0, // every query is "slow" → deterministic assertion
    });
    sql._setTag([{ id: "x" }]);
    await runOk(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    const warns = fake.calls.filter((c) => c.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toBe("rag_store.slow_query");
    expect(warns[0]?.fields?.op).toBe("template");
    expect(typeof warns[0]?.fields?.ms).toBe("number");
    // Fields carry ONLY {op, ms} — no SQL text / bound values may leak.
    expect(Object.keys(warns[0]?.fields ?? {}).sort()).toEqual(["ms", "op"]);
  });

  it("logs errors and fails with the classified StoreError when a query fails", async () => {
    const fake = makeFakeLogger();
    const store = createPostgresRagStore(
      makeBoomSql(() => new Error("db down")),
      {
        logger: fake.logger,
      },
    );
    const err = await runFail(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    expect(err.kind).toBe("transport");
    expect((err.cause as Error).message).toBe("db down");
    const errs = fake.calls.filter((c) => c.level === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0]?.msg).toBe("rag_store.query_failed");
    expect(errs[0]?.fields?.op).toBe("template");
  });

  it("does not warn when queries stay under slowQueryMs", async () => {
    const fake = makeFakeLogger();
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql, {
      logger: fake.logger,
      slowQueryMs: Number.MAX_SAFE_INTEGER,
    });
    sql._setTag([{ id: "x" }]);
    await runOk(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    expect(fake.calls).toHaveLength(0);
  });
});

describe("rag-store-factory: createRagStore", () => {
  it("returns a working Postgres-backed RagStore for provider 'postgres'", async () => {
    const sql = makeFakeSql();
    const store = createRagStore("postgres", sql);
    sql._setTag([{ id: "p1" }]);
    const id = await runOk(
      store.insertDocParent({
        sourceKey: "k",
        title: null,
        metadata: {},
      }),
    );
    expect(id).toBe("p1");
    expect(sql._calls[0]?.text).toContain("INSERT INTO doc_parents");
  });

  it("forwards adapter options (logger) to the chosen backend", async () => {
    const fake = makeFakeLogger();
    const sql = makeFakeSql();
    const store = createRagStore("postgres", sql, {
      logger: fake.logger,
      slowQueryMs: 0,
    });
    sql._setTag([{ id: "p1" }]);
    await runOk(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    expect(fake.calls.some((c) => c.msg === "rag_store.slow_query")).toBe(true);
  });

  it("throws on a provider that has no adapter (runtime exhaustiveness guard)", () => {
    const sql = makeFakeSql();
    // Simulates a provider joined to RagStoreProvider without a case in the
    // switch: the default branch must fail loudly, not silently return.
    expect(() => createRagStore("memory" as "postgres", sql)).toThrow(
      /no RagStore adapter for provider: memory/,
    );
  });
});

// Eval ledger methods — unit coverage for SQL construction and report parsing.

import { parseEvalRunReport } from "@app/contracts";

describe("Postgres eval-ledger methods (unit, fake SQL)", () => {
  it("insertEvalRun stores the label and the JSONB report, idempotent by id", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setTag([{ id: "run-1" }]);
    const id = await runOk(
      store.insertEvalRun({
        label: "lbl",
        report: { pending: true } as never,
      }),
    );
    expect(id).toBe("run-1");
    expect(sql._calls[0]?.text).toContain("INSERT INTO eval_runs");
    expect(sql._calls[0]?.text).toContain("ON CONFLICT (id) DO UPDATE");
  });

  it("refreshEvalRun upserts the final report by run id (A3/A4)", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    await runOk(
      store.refreshEvalRun("run-1", "lbl", {
        runId: "run-1",
        setId: "set",
        startedAt: 1,
        finishedAt: 2,
        questions: 1,
        passed: 1,
        failed: 0,
        skipped: 0,
        meanRetrievalRecall: 1,
        meanCitationValidity: 1,
        costMicroUsd: 0,
        budgetExceeded: false,
        results: [],
        costs: [],
      }),
    );
    expect(sql._calls[0]?.text).toContain("INSERT INTO eval_runs");
    expect(sql._calls[0]?.text).toContain("ON CONFLICT (id) DO UPDATE");
  });

  it("insertEvalResult binds questionId as a loose string, runId as uuid (B3)", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    await runOk(
      store.insertEvalResult({
        runId: "0e1b1e58-aaaa-4a86-b1e8-1a2b3c4d5e60",
        questionId: "gs-v0-001",
        answerTraceId: null,
        outcome: { passed: true },
      }),
    );
    expect(sql._calls[0]?.text).toContain("INSERT INTO eval_results");
    // runId is bound for the `::uuid` cast; questionId stays a loose string with
    // no cast in the SQL text.
    expect(sql._calls[0]?.values[1]).toBe("0e1b1e58-aaaa-4a86-b1e8-1a2b3c4d5e60");
    expect(sql._calls[0]?.values[2]).toBe("gs-v0-001");
  });

  it("getEvalRun parses the stored report with parseEvalRunReport (A5)", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    const valid = parseEvalRunReport({
      runId: "0e1b1e58-1a2b-3c4d-5e60-0e1b1e581a2b",
      setId: "s",
      startedAt: 1,
      finishedAt: 2,
      questions: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      meanRetrievalRecall: null,
      meanCitationValidity: null,
      costMicroUsd: 0,
      budgetExceeded: false,
      results: [],
      costs: [],
    });
    sql._setTag([{ id: "run-1", label: "l", report: valid, created_at: new Date(0) }]);
    const report = await runOk(store.getEvalRun("run-1"));
    expect(report).toEqual(valid);
  });

  it("getEvalRun fails with a constraint-class error on a mis-shaped report (A5)", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setTag([
      { id: "run-1", label: "l", report: { totally: "wrong" }, created_at: new Date(0) },
    ]);
    const exit = await Effect.runPromiseExit(store.getEvalRun("run-1"));
    // The parse failure must be a typed StoreError, never a thrown exception.
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("listEvalRuns maps snake_case rows", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setTag([{ id: "r1", label: "l", created_at: new Date(1700000000000) }]);
    const rows = await runOk(store.listEvalRuns({ limit: 5 }));
    expect(rows[0]).toMatchObject({ id: "r1", label: "l" });
  });

  it("getEvalResultsByRun maps snake_case outcome rows", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setTag([
      { id: "er1", question_id: "gs-v0-001", answer_trace_id: null, outcome: { passed: true } },
    ]);
    const rows = await runOk(store.getEvalResultsByRun("run-1"));
    expect(rows[0]?.questionId).toBe("gs-v0-001");
    expect(rows[0]?.outcome).toEqual({ passed: true });
  });

  it("getAnswerTraceById reads by row id and parses the trace tolerantly", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setTag([{ trace: sampleTrace }]);
    const trace = await runOk(store.getAnswerTraceById("row-1"));
    expect(sql._calls[0]?.text).toContain("WHERE id = ?::uuid");
    expect(trace?.id).toBe("t1");
    sql._setTag([]);
    expect(await runOk(store.getAnswerTraceById("missing"))).toBeNull();
  });

  it("getDocChildrenByIds dedupes ids, strips vectors, and carries the parent title", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setQuery([
      {
        id: "c1",
        parent_id: "p1",
        text_raw: "raw",
        text_ar: "ar",
        text_id: "id",
        citation: { sourceType: "s1", unit: 2, part: 255 },
        embedding_primary: null,
        embedding_fallback: null,
        ordinal: 0,
        metadata: { citation: "QS. 2:255" },
        created_at: new Date(0),
        parent_title: "Al-Baqarah",
      },
    ]);
    const rows = await runOk(store.getDocChildrenByIds(["c1", "c1", "  "]));
    expect(sql._calls[0]?.values).toEqual([["c1"]]);
    expect(sql._calls[0]?.text).toContain("ANY($1::uuid[])");
    expect(sql._calls[0]?.text).toContain("LEFT JOIN doc_parents");
    const row = rows[0];
    expect(row).toMatchObject({ id: "c1", parentTitle: "Al-Baqarah", textAr: "ar" });
    // The embedding-stripping contract: null vectors, like similaritySearch.
    expect(row?.embeddingPrimary).toBeNull();
    expect(row?.embeddingFallback).toBeNull();
  });

  it("getDocChildrenByIds short-circuits to an empty result without a query", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    const rows = await runOk(store.getDocChildrenByIds([]));
    expect(rows).toEqual([]);
    expect(sql._calls).toEqual([]);
  });

  it("getDocChildrenByIds maps a null parent title to null", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setQuery([
      {
        id: "c2",
        parent_id: "pX",
        text_raw: "raw",
        text_ar: "ar",
        text_id: null,
        citation: {},
        embedding_primary: null,
        embedding_fallback: null,
        ordinal: 1,
        metadata: {},
        created_at: new Date(0),
        parent_title: null,
      },
    ]);
    const rows = await runOk(store.getDocChildrenByIds(["c2"]));
    expect(rows[0]?.parentTitle).toBeNull();
    expect(rows[0]?.textId).toBeNull();
  });

  it("countDocChildrenByMetadata binds the key as a parameter and passes rows through", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setQuery([
      { value: "bukhari", count: 7130 },
      { value: "malik", count: 1829 },
      { value: null, count: 3 },
    ]);
    const rows = await runOk(store.countDocChildrenByMetadata("collection"));
    // The key is bound, never interpolated into the SQL text.
    expect(sql._calls[0]?.values).toEqual(["collection"]);
    expect(sql._calls[0]?.text).toContain("metadata->$1");
    expect(sql._calls[0]?.text).toContain("GROUP BY metadata->$1");
    expect(rows).toEqual([
      { value: "bukhari", count: 7130 },
      { value: "malik", count: 1829 },
      { value: null, count: 3 },
    ]);
  });

  it("countDocChildrenByMetadata maps a driver exception to a StoreError", async () => {
    const sql = makeBoomSql(() => new Error("ECONNREFUSED connect"));
    const store = createPostgresRagStore(sql);
    const err = await runFail(store.countDocChildrenByMetadata("collection"));
    expect(err.kind).toBe("transport");
  });

  it("listDocChildrenByParentSourceKey binds the key and limit, orders by ordinal (ADR-0045)", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    // Domain-neutral fixtures: engine package, so the example values are placeholders.
    sql._setQuery([
      {
        id: "c1",
        parent_id: "p1",
        text_raw: "raw-1",
        text_ar: "ar-1",
        text_id: "id-1",
        citation: { sourceType: "src", unit: 1, part: 1 },
        embedding_primary: null,
        embedding_fallback: null,
        ordinal: 0,
        metadata: { citation: "REF. 1:1" },
        created_at: new Date(0),
        parent_title: "Parent One",
      },
      {
        id: "c2",
        parent_id: "p1",
        text_raw: "raw-2",
        text_ar: "ar-2",
        text_id: "id-2",
        citation: { sourceType: "src", unit: 1, part: 2 },
        embedding_primary: null,
        embedding_fallback: null,
        ordinal: 1,
        metadata: { citation: "REF. 1:2" },
        created_at: new Date(0),
        parent_title: "Parent One",
      },
    ]);
    const rows = await runOk(
      store.listDocChildrenByParentSourceKey("collection/part/1", { limit: 12 }),
    );
    expect(sql._calls[0]?.values).toEqual(["collection/part/1", 12, 0]);
    expect(sql._calls[0]?.text).toContain("WHERE p.source_key = $1");
    expect(sql._calls[0]?.text).toContain("AND c.ordinal >= $3");
    expect(sql._calls[0]?.text).toContain("ORDER BY c.ordinal ASC");
    expect(sql._calls[0]?.text).toContain("LIMIT $2");
    expect(rows.map((r) => r.id)).toEqual(["c1", "c2"]);
    expect(rows[0]).toMatchObject({ parentTitle: "Parent One", textAr: "ar-1" });
    expect(rows[0]?.embeddingPrimary).toBeNull();
    expect(rows[0]?.embeddingFallback).toBeNull();
  });

  it("listDocChildrenByParentSourceKey moves the window's start with fromOrdinal", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setQuery([]);
    await runOk(
      store.listDocChildrenByParentSourceKey("collection/part/1", {
        limit: 13,
        fromOrdinal: 254,
      }),
    );
    // The lower bound is a bound parameter, never interpolated into the statement.
    expect(sql._calls[0]?.values).toEqual(["collection/part/1", 13, 254]);
    expect(sql._calls[0]?.text).toContain("AND c.ordinal >= $3");
  });

  it("listDocChildrenByParentSourceKey short-circuits a non-positive limit without a query", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    expect(
      await runOk(store.listDocChildrenByParentSourceKey("collection/part/1", { limit: 0 })),
    ).toEqual([]);
    expect(sql._calls).toEqual([]);
  });

  it("listDocChildNeighboursByChildIds binds the anchors, radius and limit in order (ADR-0049)", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setQuery([
      {
        id: "n1",
        parent_id: "p1",
        text_raw: "raw-n1",
        text_ar: "ar-n1",
        text_id: "id-n1",
        citation: { sourceType: "src", unit: 1, part: 1 },
        embedding_primary: null,
        embedding_fallback: null,
        ordinal: 0,
        metadata: { citation: "REF. 1:1" },
        created_at: new Date(0),
        parent_title: "Parent One",
      },
    ]);
    const rows = await runOk(
      store.listDocChildNeighboursByChildIds(["c-anchor-1", "c-anchor-2"], {
        radius: 2,
        limit: 7,
      }),
    );
    // Every knob is a bound parameter: the anchor array — whose ORDER the adapter
    // preserves as the read's priority order — the radius, and the limit.
    expect(sql._calls[0]?.values).toEqual([["c-anchor-1", "c-anchor-2"], 2, 7]);
    expect(sql._calls[0]?.text).toContain("unnest($1::uuid[]) WITH ORDINALITY");
    expect(sql._calls[0]?.text).toContain("n.ordinal BETWEEN an.ordinal - $2 AND an.ordinal + $2");
    // The join names the CTE's PROJECTED column (`anchor_id`): a text canary only
    // — the executable contract for this read lives in the real-Postgres suite.
    expect(sql._calls[0]?.text).toContain("n.id <> an.anchor_id");
    expect(sql._calls[0]?.text).toContain("DISTINCT ON (n.id)");
    expect(sql._calls[0]?.text).toContain("ORDER BY w.anchor_pos, w.ordinal, w.id");
    expect(sql._calls[0]?.text).toContain("LIMIT $3");
    expect(rows.map((r) => r.id)).toEqual(["n1"]);
    expect(rows[0]?.embeddingPrimary).toBeNull();
    expect(rows[0]?.embeddingFallback).toBeNull();
    expect(rows[0]).toMatchObject({ parentTitle: "Parent One", textAr: "ar-n1" });
  });

  it("listDocChildNeighboursByChildIds short-circuits radius, limit and empty anchors", async () => {
    for (const opts of [
      { radius: 0, limit: 7 },
      { radius: -1, limit: 7 },
      { radius: 2, limit: 0 },
      { radius: 2, limit: -1 },
    ]) {
      const sql = makeFakeSql();
      const store = createPostgresRagStore(sql);
      expect(await runOk(store.listDocChildNeighboursByChildIds(["c-anchor-1"], opts))).toEqual([]);
      expect(sql._calls, JSON.stringify(opts)).toEqual([]);
    }
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    expect(
      await runOk(store.listDocChildNeighboursByChildIds([], { radius: 1, limit: 7 })),
    ).toEqual([]);
    expect(
      await runOk(store.listDocChildNeighboursByChildIds(["  "], { radius: 1, limit: 7 })),
    ).toEqual([]);
    expect(sql._calls).toEqual([]);
  });

  it("listDocChildNeighboursByChildIds deduplicates a repeated anchor", async () => {
    const sql = makeFakeSql();
    const store = createPostgresRagStore(sql);
    sql._setQuery([]);
    await runOk(
      store.listDocChildNeighboursByChildIds(["c-1", "c-1", "c-2"], { radius: 1, limit: 4 }),
    );
    expect(sql._calls[0]?.values?.[0]).toEqual(["c-1", "c-2"]);
  });

  it("listDocChildNeighboursByChildIds maps a driver exception to a StoreError", async () => {
    const sql = makeBoomSql(() => new Error("ECONNREFUSED connect"));
    const store = createPostgresRagStore(sql);
    const err = await runFail(
      store.listDocChildNeighboursByChildIds(["c-1"], { radius: 1, limit: 4 }),
    );
    expect(err.kind).toBe("transport");
  });
});
