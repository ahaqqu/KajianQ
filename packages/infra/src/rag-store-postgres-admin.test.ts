// @requires-postgres
import { traceTotals, type Trace } from "@app/contracts";
import { Effect, Exit } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createPostgresRagStore } from "./rag-store-postgres";
import { ROW_COLUMNS, ROW_FIELDS, ROW_FROM } from "./rag-store-postgres-admin-row";
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
 * REQUIRES A DISPOSABLE DATABASE. The suite cannot clean up after itself in the log —
 * deleting a fresh row is the thing the table forbids — so its records stay behind,
 * and its backdated fixture is deleted by the purge. Run against a shared or staging
 * database it would inject fake accountability evidence that no one can remove for 90
 * days; an empty log is no evidence of a throwaway — a freshly migrated staging box has
 * one too — so `beforeAll` refuses unless `KAJIANQ_ADMIN_TEST_DISPOSABLE=1` accompanies
 * `DATABASE_URL`, and then refuses again if the log already holds a record this suite
 * did not write (any actor not prefixed `ct-`). Disposability is a fact the operator
 * states, never one this suite infers.
 */

const URL = process.env.DATABASE_URL;
const run = URL ? describe : describe.skip;

/** The explicit disposability fact: an operator states it; the suite never infers it. */
const DISPOSABLE = process.env.KAJIANQ_ADMIN_TEST_DISPOSABLE === "1";

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
    // First gate: disposability is a positive fact. An empty log cannot tell a throwaway
    // database from a staging box whose admin surface is still off, so the run only proceeds
    // when the operator says the target is disposable.
    if (!DISPOSABLE) {
      throw new Error(
        "rag-store-postgres-admin: DATABASE_URL is set but this run did not state that the " +
          "database is disposable. Set KAJIANQ_ADMIN_TEST_DISPOSABLE=1 when DATABASE_URL names a " +
          "throwaway database (a scratch instance with `bun run db:up:all`); this suite writes " +
          "append-only admin_access_log rows that cannot be removed for 90 days, so it will not " +
          "guess from an empty log.",
      );
    }
    sql = postgresSqlRunner(postgresPool(URL));
    // Second gate: this suite's runs are the only rows the log may already hold. A database
    // holding a record written by anyone else is not disposable, and the append-only rule
    // means this run cannot undo what it would add.
    const foreign = (await sql.query(
      `SELECT 1 FROM admin_access_log WHERE actor NOT LIKE 'ct-%' LIMIT 1`,
    )) as unknown[];
    if (foreign.length > 0) {
      throw new Error(
        "rag-store-postgres-admin: DATABASE_URL must name a DISPOSABLE database — it already " +
          "holds admin_access_log rows this suite did not write (an actor not prefixed `ct-`). " +
          "The log is append-only, so a run here would add fake evidence that cannot be removed " +
          "for 90 days. Point DATABASE_URL at a throwaway database (bun run db:up:all) to run it.",
      );
    }
    store = createPostgresRagStore(sql);
  });

  afterAll(async () => {
    // Revocation rows carry no evidence value and the table is not append-only: this
    // suite removes only the ids it minted, so a re-run starts from its own state.
    if (sql) {
      await sql
        .query(`DELETE FROM admin_session_revocations WHERE jti LIKE 'ct-%'`)
        .catch(() => {});
    }
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

  it("projects exactly the Row's fields, so the SQL and the mapping cannot drift", async () => {
    if (!URL) return;
    // `ROW_COLUMNS` is template-literal SQL and `Row` is a hand-written type, so the
    // compiler cannot compare the two sides. A live row can: the driver reports the select
    // list's alias set, which must be exactly the runtime list `Row` is compiled from.
    // A column dropped from the SQL while its `Row` field stays would read `undefined`;
    // this is the gate that reddens instead of blanking the cell.
    await seedAnswer({ question: "column set", answer: "column set", trace: twoCallTrace() });
    const rows = (await sql!.query(`SELECT ${ROW_COLUMNS} ${ROW_FROM} LIMIT 5`)) as Record<
      string,
      unknown
    >[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([...ROW_FIELDS].sort());
    }
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

  it("counts every matching row even when the page itself is empty", async () => {
    if (!URL) return;
    // The window rides the rows, so an offset past the end has no value to read it from —
    // that one case falls back to a count rather than reporting a total of zero.
    const page = await Effect.runPromise(store.listAdminTraces({}, { limit: 5, offset: 100_000 }));
    expect(page.rows).toEqual([]);
    expect(page.total).toBeGreaterThan(0);
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

  it("serves a stored trace this contract cannot parse through the raw read", async () => {
    if (!URL) return;
    const fixture = await seedAnswer({
      question: "unparseable question",
      answer: "unparseable answer",
      trace: twoCallTrace(),
    });
    // An out-of-band shape (an older row, or a contract tightening) is exactly what the raw
    // download exists for: the structured read fails typed, the raw read still serves it.
    await sql!.query(
      `UPDATE answer_traces SET trace = '{"nope": true}'::jsonb WHERE id = $1::uuid`,
      [fixture.traceId],
    );
    const detail = await Effect.runPromiseExit(store.getAdminTrace(fixture.traceId));
    expect(Exit.isFailure(detail)).toBe(true);
    if (Exit.isFailure(detail)) {
      expect(String(detail.cause)).toContain("StoreError");
    }
    const raw = await Effect.runPromise(store.getAdminTraceRaw(fixture.traceId));
    expect(raw?.trace).toEqual({ nope: true });
    expect(raw?.row.question).toBe("unparseable question");
    expect(await Effect.runPromise(store.getAdminTraceRaw(crypto.randomUUID()))).toBeNull();
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

  it("revokes exactly one session id, and a retried revoke is a no-op", async () => {
    if (!URL) return;
    const first = `ct-jti-${crypto.randomUUID()}`;
    const second = `ct-jti-${crypto.randomUUID()}`;
    const expiresAt = Date.now() + 60_000;
    expect(await Effect.runPromise(store.isAdminSessionRevoked(first))).toBe(false);
    await Effect.runPromise(store.revokeAdminSession({ jti: first, expiresAt }));
    expect(await Effect.runPromise(store.isAdminSessionRevoked(first))).toBe(true);
    // A second sign-out with the same token cannot fail on its own first success.
    await Effect.runPromise(store.revokeAdminSession({ jti: first, expiresAt }));
    expect(await Effect.runPromise(store.isAdminSessionRevoked(first))).toBe(true);
    // The other live session is untouched.
    expect(await Effect.runPromise(store.isAdminSessionRevoked(second))).toBe(false);
  });

  it("prunes a revocation row once its token has expired, and keeps a live one", async () => {
    if (!URL) return;
    const expired = `ct-jti-${crypto.randomUUID()}`;
    const live = `ct-jti-${crypto.randomUUID()}`;
    await Effect.runPromise(
      store.revokeAdminSession({ jti: expired, expiresAt: Date.now() - 60_000 }),
    );
    await Effect.runPromise(
      store.revokeAdminSession({ jti: live, expiresAt: Date.now() + 60_000 }),
    );
    expect(await Effect.runPromise(store.purgeAdminSessionRevocations())).toBeGreaterThanOrEqual(1);
    expect(await Effect.runPromise(store.isAdminSessionRevoked(expired))).toBe(false);
    expect(await Effect.runPromise(store.isAdminSessionRevoked(live))).toBe(true);
  });

  it("keeps the denylist down to a random id, an expiry and a timestamp", async () => {
    if (!URL) return;
    const rows = (await sql!.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'admin_session_revocations' ORDER BY column_name`,
    )) as { column_name: string }[];
    // Same rule as the access log: a column that is not here cannot be filled later by
    // accident. No credential, no user, no content — only the session's random id.
    expect(rows.map((row) => row.column_name)).toEqual(["expires_at", "jti", "revoked_at"]);
  });

  it("refuses a NUL in the filter text at the database boundary", async () => {
    if (!URL) return;
    // Why the query parser rejects control characters: a NUL is not representable in
    // Postgres text, so a bound filter carrying one fails the read instead of matching
    // nothing. The parser is the layer that keeps it out of the request path.
    const exit = await Effect.runPromiseExit(
      store.listAdminTraces({ text: "ayat\u0000kursi" }, { limit: 1, offset: 0 }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
