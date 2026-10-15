/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createPostgresRagStore } from "./rag-store-postgres";
import { disposePostgresPools, postgresPool, postgresSqlRunner } from "./rag-store-postgres-driver";
import type { RagStore } from "./rag-store";

/**
 * RagStore contract tests against a real Postgres server.
 *
 * They only run when DATABASE_URL is set — without it they are skipped so unit
 * runs (and any environment lacking the secret) stay green. When the URL is
 * present they must be run in SERIES (`vitest --no-file-parallelism` or a
 * single-file run) because they share one fixture namespace keyed off a per-run
 * prefix; parallel runs against the same database would race.
 */

const URL = process.env.DATABASE_URL;
const run = URL ? describe : describe.skip;

// Per-run prefix isolates this test run's rows from anything else in the
// database, so the tests are idempotent and leave no residue.
let PREFIX: string;
let sql: import("./rag-store-postgres-errors").SqlRunner | null = null;
let store: RagStore;
let cleanup: () => Promise<void>;

// Every key this suite creates is `${PREFIX}${suffix}`, and cleanup deletes those
// exact keys rather than a `LIKE ${PREFIX}-%` pattern, whose reach would exceed
// the rows this suite owns in the shared database.
const SOURCE_KEY_SUFFIXES = ["", "-upsert", "-neigh-a", "-neigh-b"] as const;
const TRACE_MESSAGE_SUFFIX = "-msg-1";
const EVAL_RUN_LABEL_SUFFIX = "-run";

const corpusKey = (suffix: (typeof SOURCE_KEY_SUFFIXES)[number]) => `${PREFIX}${suffix}`;

const traceMessageId = () => `${PREFIX}${TRACE_MESSAGE_SUFFIX}`;

const evalRunLabel = () => `${PREFIX}${EVAL_RUN_LABEL_SUFFIX}`;

function vec(dim: number, seed: number): number[] {
  return Array.from({ length: dim }, (_, i) => Math.sin(seed * 1000 + i * 0.01));
}

run("RagStore contract (real Postgres, Effect-shaped seam)", () => {
  beforeAll(async () => {
    if (!URL) return;
    PREFIX = `ct-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    sql = postgresSqlRunner(postgresPool(URL));
    store = createPostgresRagStore(sql);
    cleanup = async () => {
      // Remove this run's fixture rows by the exact key each fixture writes: the
      // database is shared, so a `LIKE ${PREFIX}-%` pattern would over-reach.
      await sql!`DELETE FROM users WHERE id IN (
        SELECT user_id FROM chat_sessions WHERE metadata->>'pfx' = ${PREFIX}
      )`;
      await sql!`DELETE FROM answer_traces WHERE message_id = ${traceMessageId()}`;
      await sql!`DELETE FROM eval_runs WHERE label = ${evalRunLabel()}`;
      // The corpus fixtures key their source_key off PREFIX with a suffix, so a
      // bare-prefix delete would leave them — and their cascade children — behind.
      await sql!`DELETE FROM doc_parents
        WHERE source_key = ANY(${SOURCE_KEY_SUFFIXES.map(corpusKey)}::text[])`;
    };
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
    // Release the memoized pools so the vitest worker exits cleanly.
    await disposePostgresPools();
  });

  it("round-trips a vector insert + similarity search on embedding_primary", async () => {
    if (!URL) return;
    const ar = vec(1536, 1);
    const program = Effect.gen(function* () {
      const parentId = yield* store.insertDocParent({
        sourceKey: corpusKey(""),
        title: "contract-fixture",
        metadata: { pfx: PREFIX },
      });
      const childId = yield* store.insertDocChild({
        parentId,
        textRaw: "raw-fixture",
        textAr: "text-ar-fixture",
        textId: "text-id-fixture",
        citation: { s: 2, a: 255 },
        embeddingPrimary: ar,
        embeddingFallback: null,
        ordinal: 0,
        metadata: { pfx: PREFIX },
      });
      const hits = yield* store.similaritySearch("primary", ar, {
        limit: 5,
        filters: { pfx: PREFIX },
      });
      return { childId, hits };
    });
    const { childId, hits } = await Effect.runPromise(program);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.child.id).toBe(childId);
    expect(hits[0]?.distance ?? 1).toBeLessThan(1e-6);
    // A hit carries no vectors: the search used them to order the rows, so
    // re-shipping them is dead weight. They stay stored — this read omits them.
    expect(hits[0]?.child.embeddingPrimary).toBeNull();
    expect(hits[0]?.child.embeddingFallback).toBeNull();
    expect(hits[0]?.child.citation).toEqual({ s: 2, a: 255 });
  }, 60_000);

  it("round-trips a vector insert + similarity search on embedding_fallback", async () => {
    if (!URL) return;
    const idEmb = vec(1536, 2);
    const arEmb = vec(1536, 3);
    const program = Effect.gen(function* () {
      const parentId = yield* store.insertDocParent({
        sourceKey: corpusKey(""),
        title: "contract-fixture-2",
        metadata: { pfx: PREFIX },
      });
      const childId = yield* store.insertDocChild({
        parentId,
        textRaw: "raw-fixture",
        textAr: "text-ar-fixture",
        textId: "text-id-fixture",
        embeddingPrimary: arEmb,
        embeddingFallback: idEmb,
        ordinal: 1,
        metadata: { pfx: PREFIX },
      });
      const hits = yield* store.similaritySearch("fallback", idEmb, {
        limit: 5,
        filters: { pfx: PREFIX },
      });
      // Searching the SAME row's primary embedding on the primary track must
      // also find it — the two tracks are independently queryable.
      const arHits = yield* store.similaritySearch("primary", arEmb, {
        limit: 5,
        filters: { pfx: PREFIX },
      });
      return { childId, hits, arHits };
    });
    const { childId, hits, arHits } = await Effect.runPromise(program);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.child.id).toBe(childId);
    expect(hits[0]?.distance ?? 1).toBeLessThan(1e-6);
    expect(arHits.some((h) => h.child.id === childId)).toBe(true);
  }, 60_000);

  it("creates an anonymous session, resolves it by token, and cascade-deletes the user", async () => {
    if (!URL) return;
    const program = Effect.gen(function* () {
      const { userId, token, expiresAt } = yield* store.createSession();
      const resolved = yield* store.resolveUserId(token);
      const sessionId = yield* store.createChatSession({
        userId,
        metadata: { pfx: PREFIX },
      });
      yield* store.insertChatMessage({ sessionId, role: "user", content: "hi" });
      yield* store.deleteUserCascade(userId);
      const after = yield* store.resolveUserId(token);
      return { expiresAt, resolved, after };
    });
    const { expiresAt, resolved, after } = await Effect.runPromise(program);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(resolved).toBeDefined();
    expect(after).toBeNull();
  }, 60_000);

  it("persists and reads back a @app/contracts Trace, and cascade-deletes it with the user", async () => {
    if (!URL) return;
    // The trace must be owned by a user so it cascades on deletion; tagging its
    // chat_session with pfx lets the cleanup find that user.
    const trace = {
      id: "trace-1",
      createdAt: 1_700_000_000_000,
      events: [
        {
          stage: "generator" as const,
          kind: "llm_call" as const,
          cost: {
            modelId: "cfg:generator",
            tokensIn: 120,
            tokensOut: 340,
            latencyMs: 812,
            costMicroUsd: 412,
          },
          at: 1_700_000_000_100,
        },
      ],
    };
    const messageId = traceMessageId();
    const program = Effect.gen(function* () {
      const { userId, token } = yield* store.createSession();
      const chatSessionId = yield* store.createChatSession({ userId, metadata: { pfx: PREFIX } });
      const storedTraceId = yield* store.insertAnswerTrace({ messageId, userId, trace });
      // `chat_messages.answer_trace_id` FKs `answer_traces(id)`, so it must carry
      // the id the store RETURNED — not `trace.id`, which may not be a uuid.
      yield* store.insertChatMessage({
        sessionId: chatSessionId,
        role: "assistant",
        content: "grounded answer",
        answerTraceId: storedTraceId,
      });
      // The eval ledger path: a STRING question id and the stored trace id both persist.
      const evalRunId = yield* store.insertEvalRun({
        label: evalRunLabel(),
        report: {} as never,
      });
      yield* store.insertEvalResult({
        runId: evalRunId,
        questionId: "gs-v0-019",
        answerTraceId: storedTraceId,
        outcome: {
          questionId: "gs-v0-019",
          expectedBehavior: "refuse",
          passed: true,
          retrievalRecall: 1,
          citationValidity: 1,
          refused: true,
        },
      });
      // Tolerant reader: a trace stored without `version` reads back unchanged.
      const fetched = yield* store.getAnswerTraceByMessage(messageId);
      const absent = yield* store.getAnswerTraceByMessage(`${PREFIX}-nope`);
      // Cascade: deleting the user removes their traces (the user_id FK), so the
      // message's trace is gone and the session token no longer resolves.
      yield* store.deleteUserCascade(userId);
      const gone = yield* store.getAnswerTraceByMessage(messageId);
      const deadToken = yield* store.resolveUserId(token);
      return { fetched, absent, gone, deadToken };
    });
    const { fetched, absent, gone, deadToken } = await Effect.runPromise(program);
    expect(fetched).toEqual(trace);
    expect(fetched?.version).toBeUndefined();
    expect(absent).toBeNull();
    expect(gone).toBeNull();
    expect(deadToken).toBeNull();
  }, 60_000);

  it("persists feedback against a trace target, reads it back, and cascade-deletes it (#13)", async () => {
    if (!URL) return;
    // The API contract admits only uuid messageIds, and the target read casts
    // the parameter for the chat-row-id branch — the fixture uses a real uuid.
    const messageId = crypto.randomUUID();
    const trace = { id: "trace-fb", createdAt: 1_700_000_000_000, events: [] };
    const program = Effect.gen(function* () {
      const { userId, token } = yield* store.createSession();
      const chatSessionId = yield* store.createChatSession({ userId, metadata: { pfx: PREFIX } });
      const storedTraceId = yield* store.insertAnswerTrace({ messageId, userId, trace });
      const chatRowId = yield* store.insertChatMessage({
        sessionId: chatSessionId,
        role: "assistant",
        content: "Allah Mahahidup [QS. 2:255].",
        answerTraceId: storedTraceId,
      });
      yield* store.insertFeedback({
        messageId,
        userId,
        rating: 1,
        anchorType: "answer",
        anchorId: null,
        category: null,
        freeText: null,
      });
      yield* store.insertFeedback({
        messageId,
        userId,
        rating: -1,
        anchorType: "citation",
        anchorId: "QS. 2:255",
        category: "wrong_citation",
        freeText: "salah surah",
        status: "pending",
      });
      // A repeat verdict UPSERTS: the functional unique index keys one verdict
      // per (user, answer, element), so the row count stays 1.
      yield* store.insertFeedback({
        messageId,
        userId,
        rating: 1,
        anchorType: "answer",
        anchorId: null,
        category: null,
        freeText: "dua kali",
      });
      const thumbRows = (yield* Effect.promise(
        () =>
          sql!`SELECT count(*)::int AS n FROM feedback
        WHERE user_id = ${userId} AND message_id = ${messageId} AND anchor_type = 'answer'`,
      )) as { n: number }[];
      const target = yield* store.getAnswerFeedbackTarget(messageId);
      // The rehydrated transcript carries the chat ROW id (store-generated), not
      // the trace's message_id — the target must resolve from both.
      const byRowId = yield* store.getAnswerFeedbackTarget(chatRowId);
      const absentTarget = yield* store.getAnswerFeedbackTarget(crypto.randomUUID());
      // A non-uuid id can only be a message-id key: it must degrade to a null
      // target, never fail at the `::uuid` cast.
      const nonUuidTarget = yield* store.getAnswerFeedbackTarget("feedback-non-uuid-probe");
      // Cascade: the feedback rows carry the user FK, so they die with the user.
      yield* store.deleteUserCascade(userId);
      const orphanedTarget = yield* store.getAnswerFeedbackTarget(messageId);
      const deadToken = yield* store.resolveUserId(token);
      return {
        thumbRows,
        target,
        byRowId,
        absentTarget,
        nonUuidTarget,
        orphanedTarget,
        deadToken,
      };
    });
    const { thumbRows, target, byRowId, absentTarget, nonUuidTarget, orphanedTarget, deadToken } =
      await Effect.runPromise(program);
    expect(target).not.toBeNull();
    expect(target?.userId).toBeTruthy();
    expect(target?.trace).toEqual(trace);
    // The target carries the trace's CANONICAL message id, whatever id the caller looked up.
    expect(target?.messageId).toBe(messageId);
    expect(target?.answerText).toBe("Allah Mahahidup [QS. 2:255].");
    expect(byRowId).toEqual(target);
    expect(absentTarget).toBeNull();
    expect(nonUuidTarget).toBeNull();
    expect(thumbRows[0]?.n).toBe(1);
    expect(orphanedTarget).toBeNull();
    expect(deadToken).toBeNull();
  }, 60_000);

  it("upserts doc parents/children idempotently by source_key / (parent_id, ordinal)", async () => {
    if (!URL) return;
    const ar = vec(1536, 7);
    const program = Effect.gen(function* () {
      const parentId = yield* store.insertDocParent({
        sourceKey: corpusKey("-upsert"),
        title: "first",
        metadata: { pfx: PREFIX, rev: 1 },
      });
      const parentId2 = yield* store.insertDocParent({
        sourceKey: corpusKey("-upsert"),
        title: "second",
        metadata: { pfx: PREFIX, rev: 2 },
      });
      const childId = yield* store.insertDocChild({
        parentId,
        textRaw: "raw-immutable",
        textAr: "ar-v1",
        textId: "id-v1",
        citation: { s: 2, a: 255 },
        embeddingPrimary: ar,
        embeddingFallback: null,
        ordinal: 9,
        metadata: { pfx: PREFIX },
      });
      // Re-insert the same (parent_id, ordinal) with refreshed derived fields →
      // same id, no duplicate; text_raw is immutable and must not change.
      const childId2 = yield* store.insertDocChild({
        parentId,
        textRaw: "raw-SHOULD-NOT-OVERWRITE",
        textAr: "ar-v2",
        textId: "id-v2",
        citation: { s: 3, a: 7 },
        embeddingPrimary: ar,
        embeddingFallback: null,
        ordinal: 9,
        metadata: { pfx: PREFIX, rev: 2 },
      });
      const hits = yield* store.similaritySearch("primary", ar, {
        limit: 5,
        filters: { pfx: PREFIX },
      });
      return { parentId, parentId2, childId, childId2, hits };
    });
    const { parentId, parentId2, childId, childId2, hits } = await Effect.runPromise(program);
    expect(parentId2).toBe(parentId);
    expect(childId2).toBe(childId);
    const me = hits.find((h) => h.child.id === childId);
    expect(me).toBeDefined();
    expect(me?.child.textRaw).toBe("raw-immutable"); // text_raw immutable
    expect(me?.child.textAr).toBe("ar-v2");
    expect(me?.child.citation).toEqual({ s: 3, a: 7 });
    expect(me?.child.metadata).toMatchObject({ rev: 2 });
  }, 60_000);

  /**
   * The neighbour read against real Postgres.
   *
   * The fake-runner unit test pins this statement's *text* only: a join
   * predicate naming an unprojected column passes a text assertion while
   * PostgreSQL rejects the statement at parse time. These rows are the only ones
   * that EXECUTE the read, and they pin its behaviour: each anchor's ordinal
   * window inside its own parent, the anchor never its own neighbour, a neighbour
   * shared by several anchors deduplicated onto the FIRST, ordering by anchor
   * position then `ordinal`, and the radius/limit bounds honoured.
   */
  describe("listDocChildNeighboursByChildIds (real Postgres, ADR-0049, #334)", () => {
    // Parent A carries ordinals 0..8; parent B carries rows at some of the SAME
    // ordinals, so a window that leaked across the parent join would show.
    const ORDINALS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const OTHER_ORDINALS = [2, 4, 6];
    let parentTitle = "";
    let at: string[] = []; // parent A: index is the ordinal
    let otherAt = new Map<number, string>(); // parent B: ordinal -> child id

    beforeAll(async () => {
      if (!URL) return;
      parentTitle = `${PREFIX}-neighbour-fixture-a`;
      const seed = (parentId: string, ordinal: number) =>
        store.insertDocChild({
          parentId,
          textRaw: `raw-neigh-${ordinal}`,
          textAr: `ar-neigh-${ordinal}`,
          textId: `id-neigh-${ordinal}`,
          citation: { fixture: "neigh", ordinal },
          embeddingPrimary: vec(1536, 500 + ordinal),
          embeddingFallback: null,
          ordinal,
          metadata: { pfx: PREFIX, ordinal },
        });
      const program = Effect.gen(function* () {
        const parentId = yield* store.insertDocParent({
          sourceKey: corpusKey("-neigh-a"),
          title: parentTitle,
          metadata: { pfx: PREFIX },
        });
        at = yield* Effect.forEach(ORDINALS, (ordinal) => seed(parentId, ordinal));
        const otherParentId = yield* store.insertDocParent({
          sourceKey: corpusKey("-neigh-b"),
          title: `${PREFIX}-neighbour-fixture-b`,
          metadata: { pfx: PREFIX },
        });
        const otherIds = yield* Effect.forEach(OTHER_ORDINALS, (ordinal) =>
          seed(otherParentId, ordinal),
        );
        otherAt = new Map(OTHER_ORDINALS.map((ordinal, i) => [ordinal, otherIds[i]!]));
      });
      await Effect.runPromise(program);
    });

    const read = (anchors: readonly string[], radius: number, limit: number) =>
      Effect.runPromise(store.listDocChildNeighboursByChildIds(anchors, { radius, limit }));

    it("executes on real Postgres and returns the anchor's ordinal window, never the anchor (the #334 row)", async () => {
      if (!URL) return;
      const rows = await read([at[3]!], 1, 10);
      expect(rows.map((r) => r.id)).toEqual([at[2], at[4]]);
      expect(rows.map((r) => r.id)).not.toContain(at[3]);
      // And the window never crosses the parent join: parent B holds rows at the
      // same ordinals 2 and 4, and neither may appear here.
      expect(rows.map((r) => r.id)).not.toContain(otherAt.get(2));
      expect(rows.map((r) => r.id)).not.toContain(otherAt.get(4));
      expect(rows[0]).toMatchObject({
        textRaw: "raw-neigh-2",
        textAr: "ar-neigh-2",
        textId: "id-neigh-2",
        citation: { fixture: "neigh", ordinal: 2 },
        metadata: { pfx: PREFIX, ordinal: 2 },
        parentTitle,
      });
      expect(rows[0]?.embeddingPrimary).toBeNull();
      expect(rows[0]?.embeddingFallback).toBeNull();
    }, 60_000);

    it("honours the radius, including at the parent's ordinal edge", async () => {
      if (!URL) return;
      expect((await read([at[3]!], 2, 10)).map((r) => r.id)).toEqual([at[1], at[2], at[4], at[5]]);
      expect((await read([at[3]!], 1, 10)).map((r) => r.id)).not.toContain(at[1]);
      // The last ordinal has no rows beyond it: the window clamps rather than
      // failing or inventing rows.
      expect((await read([at[8]!], 3, 10)).map((r) => r.id)).toEqual([at[5], at[6], at[7]]);
    }, 60_000);

    it("deduplicates a neighbour shared by two anchors onto the FIRST anchor, and orders by anchor position then ordinal", async () => {
      if (!URL) return;
      // Anchors at ordinals 2 and 5 with radius 3: ordinals 3 and 4 fall in BOTH
      // windows, so each is attributed to the first anchor and that window comes
      // first. An anchor inside the *other* anchor's window is expected — the
      // read excludes an anchor from its own window only.
      expect((await read([at[2]!, at[5]!], 3, 20)).map((r) => r.id)).toEqual([
        at[0],
        at[1],
        at[3],
        at[4],
        at[5],
        at[2],
        at[6],
        at[7],
        at[8],
      ]);
    }, 60_000);

    it("truncates by anchor priority, so the cap keeps the best-ranked anchor's window", async () => {
      if (!URL) return;
      // Capped at four, the read keeps the first anchor's window: priority is the
      // caller's array order, NOT the anchors' ordinal order.
      expect((await read([at[2]!, at[5]!], 3, 4)).map((r) => r.id)).toEqual([
        at[0],
        at[1],
        at[3],
        at[4],
      ]);
      expect((await read([at[5]!, at[2]!], 3, 4)).map((r) => r.id)).toEqual([
        at[2],
        at[3],
        at[4],
        at[6],
      ]);
      expect((await read([at[4]!], 2, 2)).map((r) => r.id)).toEqual([at[2], at[3]]);
    }, 60_000);

    it("drops an anchor id no stored row backs, without failing the read", async () => {
      if (!URL) return;
      // A retrieved id with no row behind it cannot anchor a window: the read
      // stays a read and the known anchor still returns its own window.
      expect((await read([crypto.randomUUID(), at[1]!], 1, 10)).map((r) => r.id)).toEqual([
        at[0],
        at[2],
      ]);
    }, 60_000);
  });
});
