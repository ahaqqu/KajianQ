// @requires-postgres
import { traceTotals, type Trace } from "@app/contracts";
import { Effect, Exit } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createPostgresRagStore } from "./rag-store-postgres";
import { disposePostgresPools, postgresPool, postgresSqlRunner } from "./rag-store-postgres-driver";
import type { SqlRunner } from "./rag-store-postgres-errors";
import type { RagStore } from "./rag-store";

/**
 * The admin Trace browser's real-Postgres contract (ADR-0064).
 *
 * Two properties can only be checked here, against the schema the deployment runs:
 *
 *  1. **the SQL totals agree with the contract's arithmetic** — the list's stored
 *     aggregate and the detail's `traceTotals` are one rule written twice (JSONB in
 *     SQL, events in TypeScript), and a drift between them would silently hide a
 *     message from a `minCostMicroUsd` filter while the detail showed it above the
 *     bound. This suite pins them together on the same trace;
 *  2. **the access log is append-only, and has no content column** — the table's own
 *     rule refuses an UPDATE and refuses a DELETE inside the retention window, so
 *     "append-only" is not a caller convention. The structural check walks
 *     `information_schema`, which is what makes "never question/answer text" a
 *     property of the schema rather than a promise about the writer.
 *
 * The suite cannot clean up after itself in the log — deleting a fresh row is the
 * thing it forbids — so its access records stay behind by design: they hold no
 * content, and the retention purge is what removes them.
 */

const URL = process.env.DATABASE_URL;
const run = URL ? describe : describe.skip;

const ACTOR = `ct-actor-${Math.floor(Math.random() * 1e9).toString(36)}`;

let sql: SqlRunner | null = null;
let store: RagStore;

type Fixture = { traceId: string; messageId: string; question: string; trace: Trace };

/** One answer: a user turn, the answer's own row, and the trace both reference. */
async function seedAnswer(input: {
  question: string;
  answer: string;
  trace: Omit<Trace, "id">;
}): Promise<Fixture> {
  const session = await Effect.runPromise(store.createSession());
  const sessionId = await Effect.runPromise(store.createChatSession({ userId: session.userId }));
  await Effect.runPromise(
    store.insertChatMessage({ sessionId, role: "user", content: input.question }),
  );
  const messageId = crypto.randomUUID();
  const traceId = await Effect.runPromise(
    store.insertAnswerTrace({
      messageId,
      userId: session.userId,
      trace: { ...input.trace, id: messageId } as Trace,
    }),
  );
  await Effect.runPromise(
    store.insertChatMessage({
      id: messageId,
      sessionId,
      role: "assistant",
      content: input.answer,
      answerTraceId: traceId,
    }),
  );
  return {
    traceId,
    messageId,
    question: input.question,
    trace: { ...input.trace, id: messageId } as Trace,
  };
}

const cost = (
  modelId: string,
  tokensIn: number,
  tokensOut: number,
  latencyMs: number,
  usd: number,
) => ({
  modelId,
  tokensIn,
  tokensOut,
  latencyMs,
  costMicroUsd: usd,
});

/** A trace with an embedding call and a generation call: the two shapes a message's
 * total must sum, and the one an operator filters on. */
function twoCallTrace(
  overrides: {
    intent?: string;
    refused?: boolean;
    relaxed?: "applied" | "probe";
    usd?: number;
  } = {},
): Omit<Trace, "id"> {
  const usd = overrides.usd ?? 21;
  return {
    createdAt: 1_700_000_000_000,
    events: [
      { stage: "router", kind: "intent", detail: { intent: overrides.intent ?? "ruling" }, at: 1 },
      {
        stage: "retriever",
        kind: "llm_call",
        detail: { purpose: "embed" },
        cost: cost("embedder-contract", 11, 0, 12.5, usd),
        at: 2,
      },
      {
        stage: "generator",
        kind: "llm_call",
        detail: { purpose: "generate" },
        cost: cost("generator-contract", 100, 250, 900.5, usd * 2),
        at: 3,
      },
      ...(overrides.refused === true
        ? [
            {
              stage: "generator" as const,
              kind: "refusal" as const,
              reason: "generator refusal",
              detail: { trigger: "generator_refusal" },
              at: 4,
            },
          ]
        : []),
      ...(overrides.relaxed !== undefined
        ? [
            {
              stage: "retriever" as const,
              kind: "filter_relaxed" as const,
              detail: {
                // An opaque filter dimension and value: the engine reads neither.
                dropped: { level: ["strict"] },
                track: "primary",
                adopted: overrides.relaxed === "applied",
              },
              at: 5,
            },
          ]
        : []),
    ],
  };
}

run("RagStore admin contract (real Postgres)", () => {
  beforeAll(async () => {
    if (!URL) return;
    sql = postgresSqlRunner(postgresPool(URL));
    store = createPostgresRagStore(sql);
  });

  afterAll(async () => {
    await disposePostgresPools();
  });

  it("reads the question and answer from the transcript, never from the trace", async () => {
    if (!URL) return;
    const fixture = await seedAnswer({
      question: "Apa itu ayat kursi?",
      answer: "Ayat kursi adalah QS. 2:255.",
      trace: twoCallTrace(),
    });
    const page = await Effect.runPromise(store.listAdminTraces({}, { limit: 500, offset: 0 }));
    const row = page.rows.find((candidate) => candidate.traceId === fixture.traceId);
    expect(row?.question).toBe("Apa itu ayat kursi?");
    expect(row?.answer).toBe("Ayat kursi adalah QS. 2:255.");
    expect(row?.messageId).toBe(fixture.messageId);
    expect(row?.intent).toBe("ruling");
    expect(row?.models).toEqual(["embedder-contract", "generator-contract"]);
    expect(row?.refused).toBe(false);
    expect(row?.filterRelaxed).toBe(false);
  });

  it("stores the list's totals with the same arithmetic the detail shows", async () => {
    if (!URL) return;
    const fixture = await seedAnswer({
      question: "totals",
      answer: "answer",
      trace: twoCallTrace({ usd: 7 }),
    });
    const page = await Effect.runPromise(store.listAdminTraces({}, { limit: 500, offset: 0 }));
    const row = page.rows.find((candidate) => candidate.traceId === fixture.traceId);
    // One rule, two spellings: the JSONB aggregate in SQL and `traceTotals` over the
    // events. A drift here is a filter that hides a message the detail shows.
    expect(row?.totals).toEqual(traceTotals(fixture.trace));
    expect(row?.totals.costMicroUsd).toBe(21);
    expect(row?.totals.tokensIn).toBe(111);
    expect(row?.totals.tokensOut).toBe(250);
    expect(row?.totals.latencyMs).toBe(913);
  });

  it("filters on the trace-derived facts and the totals", async () => {
    if (!URL) return;
    // A per-run marker: the database is shared and earlier runs left rows behind, so
    // the text assertions name their own fixture rather than "the only match".
    const marker = `mk${Math.random().toString(36).slice(2, 8)}`;
    const ruling = await seedAnswer({
      question: `ruling question ${marker}`,
      answer: `alpha answer ${marker}`,
      trace: twoCallTrace({ intent: "ruling", refused: true, relaxed: "applied", usd: 900 }),
    });
    const factual = await seedAnswer({
      question: `factual question ${marker}`,
      answer: `beta answer ${marker}`,
      trace: twoCallTrace({ intent: "factual", relaxed: "probe", usd: 3 }),
    });
    const list = (filter: Parameters<RagStore["listAdminTraces"]>[0]) =>
      Effect.runPromise(store.listAdminTraces(filter, { limit: 500, offset: 0 }));
    const ids = async (filter: Parameters<RagStore["listAdminTraces"]>[0]) =>
      (await list(filter)).rows.map((row) => row.traceId);

    expect(await ids({ intent: "ruling" })).toContain(ruling.traceId);
    expect(await ids({ intent: "factual" })).toContain(factual.traceId);
    expect(await ids({ intent: "factual" })).not.toContain(ruling.traceId);
    expect(await ids({ refused: true })).toContain(ruling.traceId);
    expect(await ids({ refused: true })).not.toContain(factual.traceId);
    // A probe that adopted nothing is not a relaxation, the same reading the panel takes.
    expect(await ids({ filterRelaxed: true })).toContain(ruling.traceId);
    expect(await ids({ filterRelaxed: true })).not.toContain(factual.traceId);
    expect(await ids({ filterRelaxed: false })).toContain(factual.traceId);
    expect(await ids({ model: "embedder-contract" })).toContain(ruling.traceId);
    // Case-insensitive on both sides of the join: question and answer.
    expect(await ids({ text: marker.toUpperCase() })).toHaveLength(2);
    expect(await ids({ text: `ALPHA ANSWER ${marker.toUpperCase()}` })).toEqual([ruling.traceId]);
    expect(await ids({ text: "no-such-text-anywhere" })).toEqual([]);
    // The bound compares the per-message total the detail shows.
    expect(await ids({ minCostMicroUsd: 1_000 })).not.toContain(factual.traceId);
    expect(await ids({ minLatencyMs: 1_000 })).not.toContain(factual.traceId);
    expect(await ids({ minLatencyMs: 900 })).toContain(ruling.traceId);
    // The date range is inclusive on both sides of an epoch-millisecond bound.
    expect(await ids({ from: 1_700_000_000_000, to: 1_700_000_000_000 })).toContain(ruling.traceId);
    expect(await ids({ from: 1_700_000_000_001 })).not.toContain(ruling.traceId);
  });

  it("pages server-side and counts every matching row", async () => {
    if (!URL) return;
    const before = await Effect.runPromise(store.listAdminTraces({}, { limit: 1, offset: 0 }));
    expect(before.rows).toHaveLength(1);
    expect(before.total).toBeGreaterThan(1);
    const second = await Effect.runPromise(
      store.listAdminTraces({}, { limit: 1, offset: before.total - 1 }),
    );
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.traceId).not.toBe(before.rows[0]?.traceId);
  });

  it("returns one trace by its row id, with the transcript's question", async () => {
    if (!URL) return;
    const fixture = await seedAnswer({
      question: "detail question",
      answer: "detail answer",
      trace: twoCallTrace(),
    });
    const record = await Effect.runPromise(store.getAdminTrace(fixture.traceId));
    expect(record?.row.question).toBe("detail question");
    expect(record?.row.answer).toBe("detail answer");
    expect(record?.trace.events).toHaveLength(fixture.trace.events.length);
    expect(record?.row.totals).toEqual(traceTotals(record!.trace));
    expect(await Effect.runPromise(store.getAdminTrace(crypto.randomUUID()))).toBeNull();
  });

  it("has no column a question, an answer or a search text could be written into", async () => {
    if (!URL) return;
    const rows = (await sql!.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'admin_access_log' ORDER BY column_name`,
    )) as { column_name: string }[];
    // The log's shape IS the privacy rule: identity, when, which route, and a
    // summary of dimensions. A content column would make the "never chat content"
    // claim a property of the writer instead of the schema.
    expect(rows.map((row) => row.column_name)).toEqual([
      "accessed_at",
      "actor",
      "filter_summary",
      "id",
      "route",
    ]);
  });

  it("refuses an UPDATE and a DELETE inside the retention window", async () => {
    if (!URL) return;
    await Effect.runPromise(
      store.recordAdminAccess({
        actor: ACTOR,
        route: "traces.list",
        summary: { textSearch: true, page: 1, pageSize: 20 },
      }),
    );
    const update = await Effect.runPromiseExit(
      Effect.tryPromise({
        try: () =>
          sql!.query(`UPDATE admin_access_log SET route = 'traces.raw' WHERE actor = $1`, [ACTOR]),
        catch: (cause) => cause,
      }),
    );
    expect(Exit.isFailure(update)).toBe(true);
    const remove = await Effect.runPromiseExit(
      Effect.tryPromise({
        try: () => sql!.query(`DELETE FROM admin_access_log WHERE actor = $1`, [ACTOR]),
        catch: (cause) => cause,
      }),
    );
    expect(Exit.isFailure(remove)).toBe(true);
    // The record survived both attempts, unchanged.
    const kept = (await sql!.query(
      `SELECT route, filter_summary FROM admin_access_log WHERE actor = $1`,
      [ACTOR],
    )) as { route: string; filter_summary: Record<string, unknown> }[];
    expect(kept).toHaveLength(1);
    expect(kept[0]?.route).toBe("traces.list");
    // …and the stored summary has no field a search text could be read back from.
    expect(Object.keys(kept[0]?.filter_summary ?? {}).sort()).toEqual([
      "page",
      "pageSize",
      "textSearch",
    ]);
  });

  it("purges only records past the retention window", async () => {
    if (!URL) return;
    await Effect.runPromise(
      store.recordAdminAccess({
        actor: ACTOR,
        route: "traces.detail",
        summary: { textSearch: false, traceId: crypto.randomUUID() },
      }),
    );
    // Backdate one row inside the append-only rule's own allowance: a row that old
    // is exactly what the retention purge may remove.
    await sql!.query(
      `INSERT INTO admin_access_log (accessed_at, actor, route, filter_summary)
       VALUES (now() - interval '200 days', $1, 'traces.raw', '{}'::jsonb)`,
      [ACTOR],
    );
    const purged = await Effect.runPromise(store.purgeAdminAccessLog());
    expect(purged).toBeGreaterThanOrEqual(1);
    const rows = (await sql!.query(
      `SELECT count(*)::int AS n, min(accessed_at) AS oldest FROM admin_access_log WHERE actor = $1`,
      [ACTOR],
    )) as { n: number; oldest: string }[];
    // The fresh records are still there; only the expired one is gone.
    expect(rows[0]?.n).toBe(2);
    expect(new Date(rows[0]!.oldest).getTime()).toBeGreaterThan(
      Date.now() - 90 * 24 * 60 * 60 * 1000,
    );
  });
});
