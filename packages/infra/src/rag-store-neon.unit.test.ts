import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import type { StoreError } from "@app/rag-core";
import { createNeonRagStore, type SqlRunner } from "./rag-store-neon";
import { createRagStore } from "./rag-store-factory";
import type { Logger, LogFields } from "./logger";
import type { Trace } from "@app/contracts";

/**
 * Unit tests for the Neon RagStore adapter using a fake `SqlRunner`. These
 * run in every environment (no database) and give the adapter's logic — SQL
 * construction, embedding validation, upsert RETURNING fallback, transaction
 * wiring, row mapping — line coverage that the secret-gated contract suite
 * (rag-store-neon.test.ts) cannot provide in the default gate job. The fake
 * records what the adapter asked the driver to do and feeds back canned rows.
 *
 * Assertions are Effect-shaped (ADR-0027 decision 7): seam calls are run via
 * `Effect.runPromise`/`Effect.runPromiseExit`, and failure assertions check
 * the `StoreError` kind + cause — never a thrown exception class.
 */

/** Run a store effect that must succeed, returning its value. */
const runOk = <A>(effect: Effect.Effect<A, StoreError>): Promise<A> => Effect.runPromise(effect);

/** Run a store effect that must fail, returning the typed StoreError. */
async function runFail<A>(effect: Effect.Effect<A, StoreError>): Promise<StoreError> {
  const exit = await Effect.runPromiseExit(effect);
  const failure = Exit.isFailure(exit)
    ? Cause.failureOption(exit.cause)
    : Option.none<StoreError>();
  if (Option.isSome(failure)) return failure.value;
  throw new Error("expected the effect to fail");
}

/** Uniform shape so access sites don't need per-variant narrowing. */
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

/** Fake runner whose tag/query/transaction calls reject with the given error. */
function makeBoomSql(error: () => unknown): SqlRunner {
  const boom = Object.assign(() => Promise.reject(error()), {
    query: () => Promise.reject(error()),
    transaction: () => Promise.reject(error()),
  }) as SqlRunner;
  return boom;
}

const VEC1536 = Array.from({ length: 1536 }, (_, i) => Math.sin(i * 0.01));

/** Recording fake Logger so tests can assert the adapter's ops logging. */
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

const sampleTrace: Trace = {
  id: "t1",
  version: 1,
  createdAt: 1,
  events: [{ stage: "generator", kind: "llm_call", at: 1 }],
};

describe("rag-store-neon adapter (fake runner)", () => {
  it("insertDocParent upserts and returns the RETURNING id, falling back to the generated id", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
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
    const store = createNeonRagStore(sql);
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
    // text_raw must NOT be in the UPDATE set (rule 13: immutable).
    expect(text).not.toMatch(/SET[^]*text_raw\s*=/);
  });

  it("insertDocChildren batches rows in a single query", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
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
    // Every placeholder in the text must be distinct, contiguous ($1..$20),
    // and resolve to the right value — the id slot is first in each row.
    const placeholders = [...batchText.matchAll(/\$\d+/g)].map((m) => m[0]);
    expect(placeholders).toHaveLength(20);
    expect(placeholders.map((p) => Number(p.slice(1)))).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    // Row 1's bound values, in column order: id, parentId, textRaw, textAr, …
    expect(typeof batchValues[0]).toBe("string");
    expect(batchValues[1]).toBe("p");
    expect(batchValues[2]).toBe("raw-1");
    expect(batchValues[3]).toBe("ar-1");
    // Row 2 starts at slot 11 (10 params per row): id, then parentId.
    expect(typeof batchValues[10]).toBe("string");
    expect(batchValues[11]).toBe("p");
    expect(batchValues[12]).toBe("raw-2");
    // JSON columns are cast in the SQL text, never inside a bound value.
    expect(batchText).toContain("::jsonb");
    for (const value of batchValues) {
      expect(typeof value !== "string" || !value.endsWith("::jsonb")).toBe(true);
    }
    // text_raw must NOT be in the UPDATE set (rule 13: immutable).
    expect(batchText).not.toMatch(/SET[^]*text_raw\s*=/);
  });

  it("insertDocChild rejects wrong-dimension embeddings before touching the DB (constraint kind)", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
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
    const store = createNeonRagStore(sql);
    sql._setQuery([
      {
        id: "c1",
        parent_id: "p1",
        text_raw: "raw",
        text_ar: "ar",
        text_id: "id",
        citation: { s: 2 },
        embedding_primary: "[0.1,0.2]",
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
    expect(hits[0]?.child.embeddingPrimary).toEqual([0.1, 0.2]);
    const q = sql._calls.find((c) => c.kind === "query");
    expect(q?.text).toContain("embedding_primary <=> $1::vector");
    // $1 embedding, $2 limit, then per filter key+array → 2 filters = params 3..6.
    expect(q?.values).toHaveLength(6);
  });

  it("similaritySearch rejects a bad-dimension embedding before querying (constraint kind)", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
    const err = await runFail(store.similaritySearch("primary", [0.1], { limit: 5 }));
    expect(err.kind).toBe("constraint");
    expect((err.cause as Error).message).toMatch(/dimension mismatch/);
    expect(sql._calls.find((c) => c.kind === "query")).toBeUndefined();
  });

  it("similaritySearch fails constraint-class on a corrupt stored vector", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
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
    const store = createNeonRagStore(sql);
    const id = await runOk(
      store.insertAnswerTrace({ messageId: "m1", userId: "u1", trace: sampleTrace }),
    );
    expect(typeof id).toBe("string");
    const text = sql._calls[0]?.text ?? "";
    expect(text).toContain("INSERT INTO answer_traces");
    expect(text).toContain("user_id");
    expect(sql._calls[0]?.values).toContain("u1");
  });

  it("insertAnswerTrace fails constraint-class on a malformed Trace", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
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
    const store = createNeonRagStore(sql);
    sql._setTag([]);
    expect(await runOk(store.getAnswerTraceByMessage("none"))).toBeNull();
    sql._setTag([{ trace: sampleTrace }]);
    const got = await runOk(store.getAnswerTraceByMessage("m1"));
    expect(got).toEqual(sampleTrace);
    expect(sql._calls[0]?.text).toContain("SELECT trace FROM answer_traces");
  });

  it("getAnswerTraceByMessage fails constraint-class on a corrupt persisted trace", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
    sql._setTag([{ trace: { id: 42 } }]);
    const err = await runFail(store.getAnswerTraceByMessage("m1"));
    expect(err.kind).toBe("constraint");
  });

  it("createChatSession and insertChatMessage issue the right inserts", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
    await runOk(store.createChatSession({ userId: "u1", metadata: { k: 1 } }));
    expect(sql._calls[0]?.text).toContain("INSERT INTO chat_sessions");
    await runOk(store.insertChatMessage({ sessionId: "s1", role: "user", content: "hi" }));
    expect(sql._calls[1]?.text).toContain("INSERT INTO chat_messages");
  });

  it("createSession writes users + sessions in one atomic transaction", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
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
    const store = createNeonRagStore(sql);
    sql._setTag([{ user_id: "u1" }]);
    expect(await runOk(store.resolveUserId("tok"))).toBe("u1");
    sql._setTag([]);
    expect(await runOk(store.resolveUserId("tok"))).toBeNull();
    expect(sql._calls[0]?.text).toContain("expires_at > now()");
  });

  it("cleanupExpiredSessions returns the count of deleted rows", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
    sql._setTag([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const n = await runOk(store.cleanupExpiredSessions());
    expect(n).toBe(3);
    expect(sql._calls[0]?.text).toContain("DELETE FROM sessions WHERE expires_at <=");
  });

  it("deleteUserCascade deletes from users (cascade does the rest)", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
    await runOk(store.deleteUserCascade("u1"));
    expect(sql._calls[0]?.text).toContain("DELETE FROM users WHERE id =");
  });

  it("classifies a NeonDbError unique violation as constraint (taxonomy, ADR-0027 d7)", async () => {
    const sql = makeBoomSql(() =>
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        name: "NeonDbError",
        code: "23505",
      }),
    );
    const store = createNeonRagStore(sql);
    const err = await runFail(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    expect(err.kind).toBe("constraint");
    expect((err.cause as { code?: string }).code).toBe("23505");
  });

  it("classifies an auth failure (28P01) as config, not transport", async () => {
    const sql = makeBoomSql(() =>
      Object.assign(new Error("authentication failed"), {
        name: "NeonDbError",
        code: "28P01",
      }),
    );
    const store = createNeonRagStore(sql);
    const err = await runFail(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    expect(err.kind).toBe("config");
  });

  it("classifies a driver timeout message as timeout", async () => {
    const sql = makeBoomSql(() => new Error("fetch timed out"));
    const store = createNeonRagStore(sql);
    const err = await runFail(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    expect(err.kind).toBe("timeout");
  });

  it("classifies an unknown network failure as transport (closed default)", async () => {
    const sql = makeBoomSql(() => new TypeError("fetch failed"));
    const store = createNeonRagStore(sql);
    const err = await runFail(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    expect(err.kind).toBe("transport");
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it("classifies schema drift (42703/42P01) as config, not constraint", async () => {
    for (const code of ["42703", "42P01"]) {
      const sql = makeBoomSql(() =>
        Object.assign(new Error(`column "x" does not exist`), {
          name: "NeonDbError",
          code,
        }),
      );
      const store = createNeonRagStore(sql);
      const err = await runFail(
        store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }),
      );
      expect(err.kind).toBe("config");
    }
  });

  it("does not SQLSTATE-classify non-Neon errors that carry a string code (B1 guard)", async () => {
    // A Node-style ErrnoException carries `code: string` but is NOT a
    // Neon/Postgres error — it must fall to the closed transport default,
    // never reach the SQLSTATE table.
    const sql = makeBoomSql(() =>
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "23505", // collides with unique_violation on purpose
      }),
    );
    const store = createNeonRagStore(sql);
    const err = await runFail(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    expect(err.kind).toBe("transport");
  });
});

describe("rag-store-neon adapter: optional ops logging", () => {
  it("propagates the original as cause, classified transport, when no logger is configured", async () => {
    const store = createNeonRagStore(makeBoomSql(() => new Error("db down")));
    const err = await runFail(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    // A generic Error carries no SQLSTATE/shape → transport (closed default),
    // with the original vendor error verbatim in cause.
    expect(err.kind).toBe("transport");
    expect((err.cause as Error).message).toBe("db down");
  });

  it("warns on slow queries with only {op, ms} fields, no SQL text or values", async () => {
    const fake = makeFakeLogger();
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql, {
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
    const store = createNeonRagStore(
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
    const store = createNeonRagStore(sql, {
      logger: fake.logger,
      slowQueryMs: Number.MAX_SAFE_INTEGER,
    });
    sql._setTag([{ id: "x" }]);
    await runOk(store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }));
    expect(fake.calls).toHaveLength(0);
  });
});

describe("rag-store-factory: createRagStore", () => {
  it("returns a working Neon-backed RagStore for provider 'neon'", async () => {
    const sql = makeFakeSql();
    const store = createRagStore("neon", sql);
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
    const store = createRagStore("neon", sql, {
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
    // Factory selection is constructor-time wiring, not a seam call — a
    // throw here is not an error kind crossing the store seam.
    expect(() => createRagStore("memory" as "neon", sql)).toThrow(
      /no RagStore adapter for provider: memory/,
    );
  });
});
