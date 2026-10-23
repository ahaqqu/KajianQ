// @requires-postgres
/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Effect, Exit } from "effect";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runFail } from "@app/rag-core/testing";
import { createPostgresRagStore } from "./rag-store-postgres";
import { disposePostgresPools, postgresPool, postgresSqlRunner } from "./rag-store-postgres-driver";
import type { MetadataFilterValue, RagStore } from "./rag-store";

/**
 * RagStore contract tests against a real Postgres server.
 *
 * They only run when DATABASE_URL is set — without it they are skipped so unit
 * runs (and any environment lacking the secret) stay green. When the URL is
 * present they must run in SERIES: `vitest.config.ts` turns file parallelism off
 * whenever a database is configured, because the suites share one database and
 * this one mutates its schema. A parallel run against the same database would
 * race.
 *
 * The `@requires-postgres` directive above is what the `postgres:contract` job
 * derives its selection from, so a suite gated on DATABASE_URL runs there without
 * anyone editing the workflow; a suite that gates on the variable and skips
 * without the directive, or reads it without the directive at all, reddens
 * `tests/scripts/pg-contract.test.mjs` and the DB-less job's report check.
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
const SOURCE_KEY_SUFFIXES = [
  "",
  "-upsert",
  "-neigh-a",
  "-neigh-b",
  "-census",
  "-sahihayn",
] as const;
const TRACE_MESSAGE_SUFFIX = "-msg-1";
const EVAL_RUN_LABEL_SUFFIX = "-run";

// The two-edge fixture table: created and dropped inside one case, never left
// behind. It sits in the `users` cascading closure while it exists, so a crashed
// earlier run's copy is cleared before any case derives that closure.
const TWO_EDGE_FIXTURE = "erasure_two_edge_fixture";

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
    await sql.query(`DROP TABLE IF EXISTS ${TWO_EDGE_FIXTURE}`);
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
          sourceTypeRecall: 1,
          citationAddressRecall: 1,
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
      const firstThumbId = yield* store.insertFeedback({
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
      const repeatThumbId = yield* store.insertFeedback({
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
      const storedThumbIds = (yield* Effect.promise(
        () =>
          sql!`SELECT id::text AS id FROM feedback
        WHERE user_id = ${userId} AND message_id = ${messageId} AND anchor_type = 'answer'`,
      )) as { id: string }[];
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
        firstThumbId,
        repeatThumbId,
        thumbRows,
        storedThumbIds,
        target,
        byRowId,
        absentTarget,
        nonUuidTarget,
        orphanedTarget,
        deadToken,
      };
    });
    const {
      firstThumbId,
      repeatThumbId,
      thumbRows,
      storedThumbIds,
      target,
      byRowId,
      absentTarget,
      nonUuidTarget,
      orphanedTarget,
      deadToken,
    } = await Effect.runPromise(program);
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
    // The insert path answers with the row the database stored, and a repeat
    // verdict on the same element answers with that same row's id.
    expect(storedThumbIds).toHaveLength(1);
    expect(firstThumbId).toBe(storedThumbIds[0]?.id);
    expect(repeatThumbId).toBe(firstThumbId);
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

  /**
   * The corpus reads, executed rather than described.
   *
   * `getDocChildrenByIds`, `countDocChildrenByMetadata` and
   * `listDocChildrenByParentSourceKey` are the reads whose other coverage is a
   * fake runner asserting the statement TEXT — and a statement PostgreSQL cannot
   * parse passes a text assertion. Each row below runs the read against the real
   * schema and pins the set it returns, empty results included, so a read that
   * stops executing shows up here as a red suite instead of a green one.
   */
  describe("the corpus reads execute against real Postgres", () => {
    const ORDINALS = [0, 1, 2];
    let parentTitle = "";
    let childAt: string[] = []; // parent A: index is the ordinal

    beforeAll(async () => {
      if (!URL) return;
      parentTitle = `${PREFIX}-census-fixture`;
      const program = Effect.gen(function* () {
        const parentId = yield* store.insertDocParent({
          sourceKey: corpusKey("-census"),
          title: parentTitle,
          metadata: { pfx: PREFIX },
        });
        childAt = yield* Effect.forEach(ORDINALS, (ordinal) =>
          store.insertDocChild({
            parentId,
            textRaw: `raw-census-${ordinal}`,
            textAr: `ar-census-${ordinal}`,
            textId: `id-census-${ordinal}`,
            citation: { fixture: "census", ordinal },
            embeddingPrimary: vec(1536, 900 + ordinal),
            embeddingFallback: null,
            ordinal,
            // The count read groups over the whole table by the key's VALUE, so
            // the value is this run's unique prefix: the group it returns is this
            // fixture's rows alone, whatever else the shared database holds.
            metadata: { pfx: PREFIX, census: PREFIX },
          }),
        );
      });
      await Effect.runPromise(program);
    });

    it("getDocChildrenByIds returns the stored rows by id, deduplicated and without vectors", async () => {
      if (!URL) return;
      const rows = await Effect.runPromise(
        store.getDocChildrenByIds([childAt[2]!, childAt[0]!, childAt[2]!]),
      );
      expect(rows.map((r) => r.id).sort()).toEqual([childAt[0]!, childAt[2]!].sort());
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(childAt[0]!)).toMatchObject({
        textRaw: "raw-census-0",
        textAr: "ar-census-0",
        textId: "id-census-0",
        citation: { fixture: "census", ordinal: 0 },
        ordinal: 0,
        metadata: { pfx: PREFIX, census: PREFIX },
        parentTitle,
      });
      // The read strips vectors the same way the similarity search does: it was
      // asked for display data, so re-shipping the embeddings is dead weight.
      expect(byId.get(childAt[0]!)?.embeddingPrimary).toBeNull();
      expect(byId.get(childAt[0]!)?.embeddingFallback).toBeNull();
      // An id no row backs is simply absent, and the read still executes.
      expect(await Effect.runPromise(store.getDocChildrenByIds([crypto.randomUUID()]))).toEqual([]);
    }, 60_000);

    it("countDocChildrenByMetadata groups the stored rows by one metadata key's value", async () => {
      if (!URL) return;
      const rows = await Effect.runPromise(store.countDocChildrenByMetadata("census"));
      expect(rows.find((r) => r.value === PREFIX)?.count).toBe(ORDINALS.length);
      // A key no row carries is the ingest CLIs' `--only-missing` zero case: no
      // group at all, rather than a row with a null value.
      expect(await Effect.runPromise(store.countDocChildrenByMetadata(`${PREFIX}-absent`))).toEqual(
        [],
      );
    }, 60_000);

    it("listDocChildrenByParentSourceKey reads one parent's children in ordinal order, capped by limit", async () => {
      if (!URL) return;
      const all = await Effect.runPromise(
        store.listDocChildrenByParentSourceKey(corpusKey("-census"), { limit: 10 }),
      );
      expect(all.map((r) => r.id)).toEqual(childAt);
      expect(all.map((r) => r.ordinal)).toEqual(ORDINALS);
      expect(all[0]).toMatchObject({
        textRaw: "raw-census-0",
        citation: { fixture: "census", ordinal: 0 },
        parentTitle,
      });
      expect(all[0]?.embeddingPrimary).toBeNull();
      // The cap truncates the tail, so the window a caller gets is the parent's
      // first ordinals rather than an arbitrary subset.
      const capped = await Effect.runPromise(
        store.listDocChildrenByParentSourceKey(corpusKey("-census"), { limit: 2 }),
      );
      expect(capped.map((r) => r.id)).toEqual(childAt.slice(0, 2));
      // `fromOrdinal` moves the window's start inclusively: the rows before the
      // bound are not read, and the bound's own row is.
      const fromMiddle = await Effect.runPromise(
        store.listDocChildrenByParentSourceKey(corpusKey("-census"), {
          limit: 10,
          fromOrdinal: 1,
        }),
      );
      expect(fromMiddle.map((r) => r.ordinal)).toEqual([1, 2]);
      // A bound past the parent's last ordinal is an empty read, not a failure.
      expect(
        await Effect.runPromise(
          store.listDocChildrenByParentSourceKey(corpusKey("-census"), {
            limit: 5,
            fromOrdinal: 3,
          }),
        ),
      ).toEqual([]);
      // A source key no parent carries is an empty read, not a failure.
      expect(
        await Effect.runPromise(
          store.listDocChildrenByParentSourceKey(`${PREFIX}-absent-parent`, { limit: 5 }),
        ),
      ).toEqual([]);
    }, 60_000);
  });

  /**
   * The derived filter case against the real schema: `metadata->>grade` reads
   * JSON `null` and a missing key alike as SQL NULL, so `key IS NULL` is the one
   * predicate that covers both, and the alternative must be OR-ed inside the
   * dimension's clause rather than AND-ed beside it. A text assertion cannot
   * prove either; these rows do.
   */
  describe("a filter's derived case executes against real Postgres", () => {
    // One row per behaviour the case must distinguish: the two collections whose
    // absent grade is covered, an absent grade outside them, and grades that are
    // stored — under a covered collection (weak, never upgraded) and outside it.
    const ROWS = [
      { slug: "bukhari-null", metadata: { grade: null, collection: "bukhari" } },
      { slug: "muslim-missing", metadata: { collection: "muslim" } },
      { slug: "nasai-null", metadata: { grade: null, collection: "nasai" } },
      { slug: "bukhari-dhaif", metadata: { grade: "dhaif", collection: "bukhari" } },
      { slug: "tirmidhi-sahih", metadata: { grade: "sahih", collection: "tirmidhi" } },
      { slug: "malik-hasan", metadata: { grade: "hasan", collection: "malik" } },
    ] as const;
    const idBySlug = new Map<string, string>();

    beforeAll(async () => {
      if (!URL) return;
      const program = Effect.gen(function* () {
        const parentId = yield* store.insertDocParent({
          sourceKey: corpusKey("-sahihayn"),
          title: `${PREFIX}-sahihayn-fixture`,
          metadata: { pfx: PREFIX },
        });
        yield* Effect.forEach(ROWS, (row, ordinal) =>
          Effect.map(
            store.insertDocChild({
              parentId,
              textRaw: `raw-${row.slug}`,
              textAr: `ar-${row.slug}`,
              textId: `id-${row.slug}`,
              citation: { fixture: "sahihayn", slug: row.slug },
              embeddingPrimary: vec(1536, 950 + ordinal),
              embeddingFallback: null,
              ordinal,
              // `pfx` isolates this fixture's rows; the other keys are the ones the
              // derived case reads.
              metadata: { pfx: PREFIX, ...row.metadata },
            }),
            (id) => {
              idBySlug.set(row.slug, id);
            },
          ),
        );
      });
      await Effect.runPromise(program);
    });

    const search = (filters: Record<string, MetadataFilterValue>) =>
      Effect.runPromise(store.similaritySearch("primary", vec(1536, 950), { limit: 10, filters }));

    it("admits an absent grade from either covered collection, and nothing else", async () => {
      if (!URL) return;
      const hits = await search({
        pfx: PREFIX,
        grade: {
          values: ["sahih"],
          whenAbsent: { key: "collection", values: ["bukhari", "muslim"] },
        },
      });
      const slugs = hits.map((h) => (h.child.citation as { slug: string }).slug).sort();
      expect(slugs).toEqual(["bukhari-null", "muslim-missing", "tirmidhi-sahih"]);
      // The ids are the fixture's own rows, not a coincidence of shape.
      expect(hits.map((h) => h.child.id).sort()).toEqual(
        ["bukhari-null", "muslim-missing", "tirmidhi-sahih"]
          .map((slug) => idBySlug.get(slug)!)
          .sort(),
      );
    }, 60_000);

    it("keeps exact-equality semantics for the same value without the derived case", async () => {
      if (!URL) return;
      const hits = await search({ pfx: PREFIX, grade: ["sahih"] });
      expect(hits.map((h) => (h.child.citation as { slug: string }).slug)).toEqual([
        "tirmidhi-sahih",
      ]);
    }, 60_000);

    it("keeps exact-equality semantics for a value set that has no derived case", async () => {
      if (!URL) return;
      // A grade the domain never expands: `hasan` returns only a stored hasan row,
      // and the ungraded sahihayn rows beside it stay out.
      const hits = await search({ pfx: PREFIX, grade: ["hasan"] });
      expect(hits.map((h) => (h.child.citation as { slug: string }).slug)).toEqual(["malik-hasan"]);
      // A value no row stores is an empty search, not a widening.
      expect(await search({ pfx: PREFIX, grade: ["mutawatir"] })).toEqual([]);
    }, 60_000);
  });

  describe("user erasure: one call empties the whole subtree", () => {
    // A row in every table the erasure claims: the session token, a chat session
    // with two messages (the assistant one linked to a trace), the trace itself,
    // and a feedback verdict anchored in it.
    const seedSubtree = async () => {
      const { userId, token } = await Effect.runPromise(store.createSession());
      const chatSessionId = await Effect.runPromise(
        store.createChatSession({ userId, metadata: { pfx: PREFIX } }),
      );
      const messageId = crypto.randomUUID();
      await Effect.runPromise(
        store.insertChatMessage({ sessionId: chatSessionId, role: "user", content: "question" }),
      );
      const storedTraceId = await Effect.runPromise(
        store.insertAnswerTrace({
          messageId,
          userId,
          trace: { id: `trace-${messageId}`, createdAt: 1_700_000_000_000, events: [] },
        }),
      );
      await Effect.runPromise(
        store.insertChatMessage({
          sessionId: chatSessionId,
          role: "assistant",
          content: "answer",
          answerTraceId: storedTraceId,
        }),
      );
      await Effect.runPromise(
        store.insertFeedback({
          messageId,
          userId,
          rating: -1,
          anchorType: "chunk",
          anchorId: "chunk-1",
          category: "irrelevant_chunk",
          freeText: "free text",
        }),
      );
      return { userId, token, chatSessionId, messageId, storedTraceId };
    };

    type SubtreeIds = { userId: string; chatSessionId: string };

    /**
     * The tables the adapter's own postcondition SQL declares as verified, read
     * from that module's markers: every backstop below is generated from the
     * declared set, so a table the erasure gains gets a case, and one it drops
     * cannot leave a case behind.
     */
    const ERASURE_SOURCE = readFileSync(
      resolve(process.cwd(), "packages/infra/src/rag-store-postgres-erasure.ts"),
      "utf8",
    );

    /**
     * Every `SELECT '<table>' AS verified_table` marker, whatever its name: a
     * marker the name pattern cannot read would generate no case and leave the
     * exact-set pin green against the same truncated parse, so the number of
     * marker sites is counted independently of the pattern and the pin compares
     * the two.
     */
    const MARKER_LITERALS = [...ERASURE_SOURCE.matchAll(/SELECT '([^']+)' AS verified_table/g)].map(
      (match) => match[1]!,
    );
    const VERIFIED_TABLE_SITES = [...ERASURE_SOURCE.matchAll(/\bAS verified_table\b/g)].length;
    const DECLARED_TABLES = [...new Set(MARKER_LITERALS)].sort();

    /**
     * The seeded ids a table can be attributed to, in bind order: `chat_messages`
     * reaches the subject through its chat session, every other table by user id.
     */
    const SUBJECT_KEYS = ["userId", "chatSessionId"] as const;
    type SubjectKey = (typeof SUBJECT_KEYS)[number];

    /**
     * How a row of a verified table is attributed to the subject: the column a
     * suppression trigger matches, and the seeded id it compares against. Keyed by
     * the declared set — a declared table with no entry has no suppression
     * backstop (its generated case reddens), and a key outside the set is a stale
     * entry the backstop pin reddens.
     */
    type Attribution = { column: string; subject: SubjectKey };
    const ATTRIBUTION: Record<string, Attribution> = {
      users: { column: "id", subject: "userId" },
      sessions: { column: "user_id", subject: "userId" },
      chat_sessions: { column: "user_id", subject: "userId" },
      // `chat_messages` has no user column: its owner is its session, and its
      // residual check runs before the `chat_sessions` delete — the only point
      // where the rows can still be attributed to the subject.
      chat_messages: { column: "session_id", subject: "chatSessionId" },
      answer_traces: { column: "user_id", subject: "userId" },
      feedback: { column: "user_id", subject: "userId" },
    };

    /** The attribution of a declared table, or the instruction that reddens a case
     * for one the postcondition gained without a backstop. */
    const attributionOf = (table: string): Attribution => {
      const attribution = ATTRIBUTION[table];
      if (!attribution) {
        throw new Error(
          `add ATTRIBUTION["${table}"]: the postcondition declares ${table}, so its backstop cannot be generated`,
        );
      }
      return attribution;
    };

    /** One count per table the erasure claims, read back through raw SQL: the
     * assertion is about the stored rows, not about the seam that wrote them.
     * Both the table list and each table's owner column are generated — from the
     * declared set and its attribution — so the query restates neither. */
    const subtreeCounts = async (ids: SubtreeIds) => {
      const counts = DECLARED_TABLES.map((table) => {
        const attribution = attributionOf(table);
        const bind = SUBJECT_KEYS.indexOf(attribution.subject) + 1;
        return `(SELECT count(*)::int FROM ${table} WHERE ${attribution.column} = $${bind}::uuid) AS ${table}`;
      });
      const rows = (await sql!.query(`SELECT ${counts.join(", ")}`, [
        ids.userId,
        ids.chatSessionId,
      ])) as Record<string, number>[];
      return rows[0]!;
    };

    /** One row per table the subtree holds (two chat messages: the question and
     * its answer), so a case can tell a seeded subtree from a swept one. */
    const SEEDED = {
      users: 1,
      sessions: 1,
      chat_sessions: 1,
      chat_messages: 2,
      answer_traces: 1,
      feedback: 1,
    };

    /** The swept subtree: every declared table at zero, derived from the declared
     * set so a table the postcondition gains cannot leave this map behind. */
    const EMPTY = Object.fromEntries(DECLARED_TABLES.map((table) => [table, 0]));

    type CascadingEdge = { name: string; table_name: string; definition: string };

    /**
     * Every cascading foreign-key edge that would remove a verified table's rows
     * with its parent, read from the schema instead of restated and grouped per
     * table: `chat_messages` reaches `users` through `chat_sessions`, so its edge
     * is the message→session FK, not a user column, and a table reached by two
     * cascading edges carries both. `users` is the root of the closure and has
     * none.
     */
    async function cascadingEdges() {
      const rows = (await sql!.query(
        `WITH RECURSIVE cascading(tbl) AS (
           SELECT 'users'::regclass::oid
           UNION
           SELECT c.conrelid
           FROM pg_constraint c
           JOIN cascading ON c.confrelid = cascading.tbl
           WHERE c.contype = 'f' AND c.confdeltype = 'c'
         )
         SELECT c.conname AS name,
                c.conrelid::regclass::text AS table_name,
                pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         JOIN cascading ON c.conrelid = cascading.tbl
         WHERE c.contype = 'f' AND c.confdeltype = 'c'
           AND c.conrelid <> 'users'::regclass`,
      )) as CascadingEdge[];
      const edges = new Map<string, CascadingEdge[]>();
      for (const row of rows) {
        edges.set(row.table_name, [...(edges.get(row.table_name) ?? []), row]);
      }
      return edges;
    }

    /**
     * Drop every cascading edge a table has, and return them with the restore that
     * puts each one back as it was defined. All of them, not one: a table the
     * schema reaches by two cascading edges whose case drops one still has its
     * rows removed by the other, which is how a sweep weakened on both sides
     * stays green.
     */
    async function withoutCascadingEdges(table: string) {
      const edges = (await cascadingEdges()).get(table) ?? [];
      for (const edge of edges) {
        await sql!.query(`ALTER TABLE ${table} DROP CONSTRAINT ${edge.name}`);
      }
      return {
        edges,
        restore: async () => {
          for (const edge of edges) {
            await sql!.query(`ALTER TABLE ${table} ADD CONSTRAINT ${edge.name} ${edge.definition}`);
          }
        },
      };
    }

    it("erases every table in one call, and a repeat call is a no-op", async () => {
      if (!URL) return;
      const ids = await seedSubtree();
      expect(await subtreeCounts(ids)).toEqual(SEEDED);

      await Effect.runPromise(store.deleteUserCascade(ids.userId));
      expect(await subtreeCounts(ids)).toEqual(EMPTY);
      // The token died with the user's sessions, and the erased subtree is not an
      // error the second time: the call is a no-op success.
      expect(await Effect.runPromise(store.resolveUserId(ids.token))).toBeNull();
      await Effect.runPromise(store.deleteUserCascade(ids.userId));
      expect(await subtreeCounts(ids)).toEqual(EMPTY);
    }, 60_000);

    // The sweep has to be the mechanism, not the FK cascade: with every cascading
    // edge a table has dropped, nothing but that table's explicit sweep can remove
    // the subject's rows, so a sweep weakened on BOTH the adapter and the restore
    // copy (`... AND false`, which a statement-by-statement text comparison cannot
    // see) leaves a row behind and the postcondition reports it. With an edge
    // intact the cascade removes the row instead and hides the edit — which is why
    // every verified table needs this case, not just the one whose FK a deployment
    // might lose.
    //
    // `users` has no edge to drop: its row is the subject, so the tree case above
    // and the final postcondition are what catch a `users` sweep that removes
    // nothing.
    for (const table of DECLARED_TABLES.filter((name) => name !== "users")) {
      it(`sweeps ${table} without the FK cascade — the sweep is the mechanism`, async () => {
        if (!URL) return;
        const attribution = attributionOf(table);
        const ids = await seedSubtree();
        const cascades = await withoutCascadingEdges(table);
        try {
          if (cascades.edges.length === 0) {
            throw new Error(
              `${table} is a declared verified table but no cascading FK edge reaches it`,
            );
          }
          expect(await subtreeCounts(ids)).toEqual(SEEDED);
          await Effect.runPromise(store.deleteUserCascade(ids.userId));
          expect(await subtreeCounts(ids)).toEqual(EMPTY);
        } finally {
          // Leave the shared schema exactly as it was found, even on a failure:
          // this table's surviving rows first (a survivor would block the
          // constraint re-add), then the rest of the subtree through the parent
          // delete, then every constraint as it was defined.
          await sql!.query(`DELETE FROM ${table} WHERE ${attribution.column} = $1::uuid`, [
            ids[attribution.subject],
          ]);
          await sql!`DELETE FROM users WHERE id = ${ids.userId}::uuid`;
          await cascades.restore();
        }
      }, 60_000);
    }

    it("drops every cascading edge a two-edge table has — one cascade left would hide a weakened sweep", async () => {
      if (!URL) return;
      // The generated cases drop the cascade of every table the `users` closure
      // reaches; this fixture is the shape a verified table can have and they must
      // keep handling — a table reached by TWO cascading edges. Dropping only one
      // leaves the other to remove the subject's rows, which is exactly how a
      // sweep weakened on both sides stays green.
      await sql!.query(`CREATE TABLE ${TWO_EDGE_FIXTURE} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE
      )`);
      const ids = await seedSubtree();
      await sql!.query(
        `INSERT INTO ${TWO_EDGE_FIXTURE} (user_id, session_id)
         SELECT $1::uuid, id FROM sessions WHERE user_id = $1::uuid`,
        [ids.userId],
      );
      const fixtureRows = async () => {
        const rows = (await sql!.query(
          `SELECT count(*)::int AS count FROM ${TWO_EDGE_FIXTURE} WHERE user_id = $1::uuid`,
          [ids.userId],
        )) as { count: number }[];
        return rows[0]!.count;
      };
      let restore = async () => {};
      try {
        const cascades = await withoutCascadingEdges(TWO_EDGE_FIXTURE);
        restore = cascades.restore;
        expect(cascades.edges).toHaveLength(2);
        // With both edges gone nothing downstream of the subject can cascade, so
        // each parent delete leaves the row: a case that dropped one edge would see
        // it vanish with the parent it left behind, and pass on a weakened sweep.
        await sql!.query(`DELETE FROM sessions WHERE user_id = $1::uuid`, [ids.userId]);
        expect(await fixtureRows()).toBe(1);
        await sql!.query(`DELETE FROM users WHERE id = $1::uuid`, [ids.userId]);
        expect(await fixtureRows()).toBe(1);
      } finally {
        // The orphaned row would violate the constraints when they are restored,
        // so it goes first; an empty fixture table validates against a parent that
        // no longer exists.
        await sql!.query(`DELETE FROM ${TWO_EDGE_FIXTURE} WHERE user_id = $1::uuid`, [ids.userId]);
        await restore();
        await sql!.query(`DROP TABLE IF EXISTS ${TWO_EDGE_FIXTURE}`);
        await sql!`DELETE FROM users WHERE id = ${ids.userId}::uuid`;
      }
    }, 60_000);

    it("a failing child delete rolls the erasure back and surfaces as an error", async () => {
      if (!URL) return;
      const { userId, chatSessionId } = await seedSubtree();
      const refusal = `refuse_feedback_${PREFIX.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      await sql!.query(
        `CREATE FUNCTION ${refusal}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'erasure refused by the contract suite'; END $$`,
      );
      await sql!.query(
        `CREATE TRIGGER ${refusal} BEFORE DELETE ON feedback FOR EACH ROW
          WHEN (OLD.user_id = '${userId}'::uuid) EXECUTE FUNCTION ${refusal}()`,
      );
      try {
        const exit = await Effect.runPromiseExit(store.deleteUserCascade(userId));
        expect(Exit.isFailure(exit)).toBe(true);
        // The whole transaction rolled back: a failed erasure leaves the subtree
        // intact rather than half-erased, so a retry can still complete it.
        expect(await subtreeCounts({ userId, chatSessionId })).toEqual(SEEDED);
      } finally {
        await sql!.query(`DROP TRIGGER IF EXISTS ${refusal} ON feedback`);
        await sql!.query(`DROP FUNCTION IF EXISTS ${refusal}()`);
      }
      // With the obstruction gone the same call completes — and now empties it.
      await Effect.runPromise(store.deleteUserCascade(userId));
      expect(await subtreeCounts({ userId, chatSessionId })).toMatchObject({
        users: 0,
        feedback: 0,
      });
    }, 60_000);

    /** A `BEFORE DELETE` trigger that silently skips the subject's rows on one
     * table — the failure the postcondition exists for: the sweep succeeds and
     * removes nothing, and the FK cascade's own delete is skipped the same way,
     * so only a count inside the transaction can see the surviving row. Returns
     * the teardown that drops the trigger and its function. */
    const suppressDeletes = async (table: string, when: string) => {
      const fn = `suppress_${table}_${PREFIX.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      await sql!.query(
        `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
      );
      await sql!.query(
        `CREATE TRIGGER ${fn} BEFORE DELETE ON ${table} FOR EACH ROW
          WHEN (${when}) EXECUTE FUNCTION ${fn}()`,
      );
      return async () => {
        await sql!.query(`DROP TRIGGER IF EXISTS ${fn} ON ${table}`);
        await sql!.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      };
    };

    // One suppression case per table the postcondition verifies, generated from
    // the declared set: the trigger makes that table's delete a no-op for the
    // subject's rows, so only the postcondition can see the survivor and roll the
    // transaction back. A weakened assertion predicate — `WHERE false` in place of
    // `WHERE EXISTS (…)`, on either side of the restore pin — lets the call
    // succeed with the row still there, so the table's case reddens.
    for (const table of DECLARED_TABLES) {
      it(`a suppressed ${table} delete fails the erasure — the residual assertion is the detector`, async () => {
        if (!URL) return;
        const attribution = attributionOf(table);
        const ids = await seedSubtree();
        const dropSuppression = await suppressDeletes(
          table,
          `OLD.${attribution.column} = '${ids[attribution.subject]}'::uuid`,
        );
        try {
          const failure = await runFail(store.deleteUserCascade(ids.userId));
          expect(failure.kind).toBe("constraint");
          // The raise names the table whose row survived; an incidental failure
          // (a foreign-key violation, a missing relation) does not read this way.
          expect(String(failure.cause)).toContain(`user erasure left rows behind in: ${table}`);
          // The postcondition raised before COMMIT, so the deletes went with the
          // transaction: the subtree is intact for a retry, never half-erased with
          // a dangling foreign key.
          expect(await subtreeCounts(ids)).toEqual(SEEDED);
        } finally {
          await dropSuppression();
        }
        // The obstruction is gone, so the same call completes the erasure.
        await Effect.runPromise(store.deleteUserCascade(ids.userId));
        expect(await subtreeCounts(ids)).toEqual(EMPTY);
      }, 60_000);
    }

    it("keys the per-table backstops to the declared set — no gap, no stale entry", () => {
      // The case set is generated from the postcondition's markers, so there is no
      // list to keep in step. The marker count is read independently of the name
      // pattern, so a marker it cannot parse reddens here instead of vanishing
      // from the set. What remains hand-maintained per table is its attribution and
      // its seeded row count — the counts query, the swept subtree and the cases
      // are generated from those — and both must cover exactly the declared set. A
      // table the postcondition gains reddens here until they exist, and a table it
      // drops reddens until the stale keys go.
      expect(MARKER_LITERALS).toHaveLength(VERIFIED_TABLE_SITES);
      expect(DECLARED_TABLES.length).toBeGreaterThan(0);
      expect(Object.keys(ATTRIBUTION).sort()).toEqual(DECLARED_TABLES);
      expect(Object.keys(SEEDED).sort()).toEqual(DECLARED_TABLES);
    });

    it("verifies every table a cascading foreign key path reaches from users", async () => {
      if (!URL) return;
      // The declared set, read from the module's own postcondition SQL: a table a
      // cascading FK path reaches from `users` is a table the erasure must verify,
      // so a migration that adds one reddens here instead of being forgotten.
      const declared = DECLARED_TABLES;
      const derived = (await sql!.query(
        `WITH RECURSIVE cascading(tbl) AS (
           SELECT 'users'::regclass::oid
           UNION
           SELECT c.conrelid
           FROM pg_constraint c
           JOIN cascading ON c.confrelid = cascading.tbl
           WHERE c.contype = 'f' AND c.confdeltype = 'c'
         )
         SELECT tbl::regclass::text AS table_name FROM cascading`,
      )) as { table_name: string }[];
      expect(declared.sort()).toEqual(derived.map((row) => row.table_name).sort());
    });

    it("keeps the eval ledger row and nulls its trace pointer — the ledger is not the subject's data", async () => {
      if (!URL) return;
      const { userId, storedTraceId } = await seedSubtree();
      // `eval_results` carries no user id and no user FK: it belongs to an eval run
      // over the Golden Set, so the erasure must not delete it, and its
      // `answer_trace_id` is `ON DELETE SET NULL` rather than CASCADE.
      const runId = crypto.randomUUID();
      await sql!`INSERT INTO eval_runs (id, label, report)
        VALUES (${runId}::uuid, ${`${PREFIX}-erasure-run`}, '{}'::jsonb)`;
      await sql!`INSERT INTO eval_results (id, run_id, question_id, answer_trace_id, outcome)
        VALUES (${crypto.randomUUID()}::uuid, ${runId}::uuid, 'gs-v0-001', ${storedTraceId}::uuid, '{}'::jsonb)`;
      try {
        await Effect.runPromise(store.deleteUserCascade(userId));
        const rows = (await sql!.query(
          "SELECT answer_trace_id FROM eval_results WHERE run_id = $1::uuid",
          [runId],
        )) as { answer_trace_id: string | null }[];
        expect(rows).toEqual([{ answer_trace_id: null }]);
      } finally {
        await sql!`DELETE FROM eval_runs WHERE id = ${runId}::uuid`;
      }
    }, 60_000);
  });
});
