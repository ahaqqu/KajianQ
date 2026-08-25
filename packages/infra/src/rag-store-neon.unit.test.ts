import { describe, expect, it } from "vitest";
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
 */

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
    const id = await store.insertDocParent({ sourceKey: "k", title: "t", metadata: { a: 1 } });
    expect(id).toBe("from-db");
    expect(sql._calls[0]?.text).toContain("INSERT INTO doc_parents");
    expect(sql._calls[0]?.text).toContain("ON CONFLICT (source_key) DO UPDATE");

    // No RETURNING row → fall back to the caller-supplied/generated id.
    sql._setTag([]);
    const id2 = await store.insertDocParent({ sourceKey: "k2", title: null, metadata: {} });
    expect(typeof id2).toBe("string");
  });

  it("insertDocChild upserts by (parent_id, ordinal) without overwriting text_raw", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
    sql._setTag([{ id: "child-1" }]);
    const id = await store.insertDocChild({
      parentId: "p",
      textRaw: "raw",
      textAr: "ar",
      textId: "id",
      embeddingPrimary: VEC1536,
      embeddingFallback: null,
      ordinal: 0,
      metadata: {},
    });
    expect(id).toBe("child-1");
    const text = sql._calls[0]?.text ?? "";
    expect(text).toContain("INSERT INTO doc_children");
    expect(text).toContain("embedding_primary, embedding_fallback");
    expect(text).toContain("ON CONFLICT (parent_id, ordinal) DO UPDATE");
    // text_raw must NOT be in the UPDATE set (rule 11: immutable).
    expect(text).not.toMatch(/SET[^]*text_raw\s*=/);
  });

  it("insertDocChild rejects wrong-dimension embeddings before touching the DB", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
    await expect(
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
    ).rejects.toThrow(/dimension mismatch/);
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
    const hits = await store.similaritySearch("primary", VEC1536, {
      limit: 5,
      filters: { pfx: "x", kind: ["a", "b"] },
    });
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

  it("similaritySearch rejects a bad-dimension embedding before querying", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
    await expect(
      store.similaritySearch("primary", [0.1], { limit: 5 }),
    ).rejects.toThrow(/dimension mismatch/);
    expect(sql._calls.find((c) => c.kind === "query")).toBeUndefined();
  });

  it("insertAnswerTrace validates the Trace and stores user_id", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
    const id = await store.insertAnswerTrace({ messageId: "m1", userId: "u1", trace: sampleTrace });
    expect(typeof id).toBe("string");
    const text = sql._calls[0]?.text ?? "";
    expect(text).toContain("INSERT INTO answer_traces");
    expect(text).toContain("user_id");
    expect(sql._calls[0]?.values).toContain("u1");
  });

  it("getAnswerTraceByMessage returns null when absent and the parsed Trace when present", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
    sql._setTag([]);
    expect(await store.getAnswerTraceByMessage("none")).toBeNull();
    sql._setTag([{ trace: sampleTrace }]);
    const got = await store.getAnswerTraceByMessage("m1");
    expect(got).toEqual(sampleTrace);
    expect(sql._calls[0]?.text).toContain("SELECT trace FROM answer_traces");
  });

  it("createChatSession and insertChatMessage issue the right inserts", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
    await store.createChatSession({ userId: "u1", metadata: { k: 1 } });
    expect(sql._calls[0]?.text).toContain("INSERT INTO chat_sessions");
    await store.insertChatMessage({ sessionId: "s1", role: "user", content: "hi" });
    expect(sql._calls[1]?.text).toContain("INSERT INTO chat_messages");
  });

  it("createSession writes users + sessions in one atomic transaction", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
    const out = await store.createSession();
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
    expect(await store.resolveUserId("tok")).toBe("u1");
    sql._setTag([]);
    expect(await store.resolveUserId("tok")).toBeNull();
    expect(sql._calls[0]?.text).toContain("expires_at > now()");
  });

  it("cleanupExpiredSessions returns the count of deleted rows", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
    sql._setTag([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const n = await store.cleanupExpiredSessions();
    expect(n).toBe(3);
    expect(sql._calls[0]?.text).toContain("DELETE FROM sessions WHERE expires_at <=");
  });

  it("deleteUserCascade deletes from users (cascade does the rest)", async () => {
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql);
    await store.deleteUserCascade("u1");
    expect(sql._calls[0]?.text).toContain("DELETE FROM users WHERE id =");
  });
});

describe("rag-store-neon adapter: optional ops logging", () => {
  it("propagates the original error untouched when no logger is configured", async () => {
    let tagReturn: unknown[] | null = null;
    const boom = Object.assign(
      () => {
        if (tagReturn === null) return Promise.reject(new Error("db down"));
        return Promise.resolve(tagReturn);
      },
      {
        query: () => Promise.resolve([]),
        transaction: () => Promise.resolve([]),
      },
    ) as SqlRunner;
    // No opts at all: the adapter must behave exactly as before the logging
    // knob existed — the raw driver error surfaces, nothing wraps it.
    const store = createNeonRagStore(boom);
    await expect(
      store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }),
    ).rejects.toThrow(/^db down$/);
  });

  it("warns on slow queries with only {op, ms} fields, no SQL text or values", async () => {
    const fake = makeFakeLogger();
    const sql = makeFakeSql();
    const store = createNeonRagStore(sql, {
      logger: fake.logger,
      slowQueryMs: 0, // every query is "slow" → deterministic assertion
    });
    sql._setTag([{ id: "x" }]);
    await store.insertDocParent({ sourceKey: "k", title: null, metadata: {} });
    const warns = fake.calls.filter((c) => c.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toBe("rag_store.slow_query");
    expect(warns[0]?.fields?.op).toBe("template");
    expect(typeof warns[0]?.fields?.ms).toBe("number");
    // Fields carry ONLY {op, ms} — no SQL text / bound values may leak.
    expect(Object.keys(warns[0]?.fields ?? {}).sort()).toEqual(["ms", "op"]);
  });

  it("logs errors and rethrows when a query fails", async () => {
    const fake = makeFakeLogger();
    let tagReturn: unknown[] | null = null;
    const boom = Object.assign(
      () => {
        if (tagReturn === null) return Promise.reject(new Error("db down"));
        return Promise.resolve(tagReturn);
      },
      {
        query: () => Promise.resolve([]),
        transaction: () => Promise.resolve([]),
      },
    ) as SqlRunner;
    const store = createNeonRagStore(boom, { logger: fake.logger });
    await expect(
      store.insertDocParent({ sourceKey: "k", title: null, metadata: {} }),
    ).rejects.toThrow(/db down/);
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
    await store.insertDocParent({ sourceKey: "k", title: null, metadata: {} });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("rag-store-factory: createRagStore", () => {
  it("returns a working Neon-backed RagStore for provider 'neon'", async () => {
    const sql = makeFakeSql();
    const store = createRagStore("neon", sql);
    sql._setTag([{ id: "p1" }]);
    const id = await store.insertDocParent({
      sourceKey: "k",
      title: null,
      metadata: {},
    });
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
    await store.insertDocParent({ sourceKey: "k", title: null, metadata: {} });
    expect(fake.calls.some((c) => c.msg === "rag_store.slow_query")).toBe(true);
  });

  it("throws on a provider that has no adapter (runtime exhaustiveness guard)", () => {
    const sql = makeFakeSql();
    // Simulates a provider joined to RagStoreProvider without a case in the
    // switch: the default branch must fail loudly, not silently return.
    expect(() =>
      createRagStore("memory" as "neon", sql),
    ).toThrow(/no RagStore adapter for provider: memory/);
  });
});