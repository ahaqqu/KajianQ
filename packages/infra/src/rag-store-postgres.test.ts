/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createPostgresRagStore } from "./rag-store-postgres";
import { disposePostgresPools, postgresPool, postgresSqlRunner } from "./rag-store-postgres-driver";
import type { RagStore } from "./rag-store";

/**
 * RagStore contract tests (#4 AC: "vector insert + similarity query
 * round-trip on both `embedding_primary` and `embedding_fallback`").
 *
 * These are integration tests against a real Postgres server (the self-hosted
 * one on the VPS post-ADR-0044; the CI contract job points DATABASE_URL at a
 * pgvector service container). They only run when DATABASE_URL is set —
 * without it they are skipped so unit-test runs (and any environment lacking
 * the secret) stay green. When the URL is present they must be run in SERIES
 * (`vitest --no-file-parallelism` or a single-file run) because they share one
 * test fixture namespace keyed off a per-run prefix; parallel runs against the
 * same database would race.
 *
 * Assertions are Effect-shaped (ADR-0027 decision 7): every seam call is
 * composed into one program per test via `Effect.gen`/`Effect.forEach` and
 * run with a single `Effect.runPromise` at the test's edge — the suite
 * exercises the seam as the seam is now shaped, not through per-call promise
 * shims.
 */

const URL = process.env.DATABASE_URL;
const run = URL ? describe : describe.skip;

// Per-run prefix isolates this test run's rows from anything else in the
// staging database, so the tests are idempotent and leave no residue.
let PREFIX: string;
let sql: import("./rag-store-postgres-errors").SqlRunner | null = null;
let store: RagStore;
let cleanup: () => Promise<void>;

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
      // Remove this run's fixture rows. userId/messageId keys carry PREFIX so
      // a failed run cannot collide with the next.
      await sql!`DELETE FROM users WHERE id IN (
        SELECT user_id FROM chat_sessions WHERE metadata->>'pfx' = ${PREFIX}
      )`;
      await sql!`DELETE FROM answer_traces WHERE message_id LIKE ${PREFIX + "-%"}`;
      await sql!`DELETE FROM eval_runs WHERE label LIKE ${PREFIX + "-%"}`;
      // The corpus fixtures key their source_key off PREFIX with a suffix
      // (`-upsert`, `-neigh-a`, …), so an exact-equality delete left every one
      // of them — and their cascade children — behind in the shared database
      // on each contract run.
      await sql!`DELETE FROM doc_parents
        WHERE source_key = ${PREFIX} OR source_key LIKE ${PREFIX + "-%"}`;
    };
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
    // Release the memoized pools so the vitest worker exits cleanly (a held
    // connection keeps the event loop alive).
    await disposePostgresPools();
  });

  it("round-trips a vector insert + similarity search on embedding_primary", async () => {
    if (!URL) return;
    const ar = vec(1536, 1);
    const program = Effect.gen(function* () {
      const parentId = yield* store.insertDocParent({
        sourceKey: PREFIX,
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
    // A hit carries no vectors: the search used them to order the rows and
    // re-shipping them cost the Worker megabytes per chat request (see
    // RagStore.similaritySearch). The stored vectors are still there — the
    // insert round-trip proves that — this method just does not return them.
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
        sourceKey: PREFIX,
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
      // Query the fallback track with the fallback-track embedding; nearest must
      // be this row, and the primary embedding stored on the same row must come
      // back unchanged.
      const hits = yield* store.similaritySearch("fallback", idEmb, {
        limit: 5,
        filters: { pfx: PREFIX },
      });
      // And searching the SAME row's primary embedding on the primary track
      // must find it too — the two tracks are independently queryable.
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
    // The trace must be owned by a user so it cascades on anonymous deletion
    // (ADR-0007 amendment). Create a session and tag its chat_session with
    // pfx so the run's cleanup can find the user.
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
    const messageId = `${PREFIX}-msg-1`;
    const program = Effect.gen(function* () {
      const { userId, token } = yield* store.createSession();
      const chatSessionId = yield* store.createChatSession({ userId, metadata: { pfx: PREFIX } });
      const storedTraceId = yield* store.insertAnswerTrace({ messageId, userId, trace });
      // `chat_messages.answer_trace_id` FKs `answer_traces(id)`, so it must
      // carry the id the store RETURNED — not `trace.id`, which the uuid column
      // cannot always hold. The route assumed `trace.id`, so every assistant
      // message write failed with a foreign-key violation and every answer
      // surfaced as a 500.
      yield* store.insertChatMessage({
        sessionId: chatSessionId,
        role: "assistant",
        content: "grounded answer",
        answerTraceId: storedTraceId,
      });
      // The eval ledger path (ADR-0034): a STRING question id ("gs-v0-019") and
      // the stored trace id must both persist. This write was impossible for the
      // project's entire history — a `//` note placed inside the SQL template
      // made every statement a syntax error (42601) — and nothing covered it, so
      // `eval_results` stayed empty while the spec claimed per-question rows.
      const evalRunId = yield* store.insertEvalRun({
        label: `${PREFIX}-run`,
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
      // Tolerant reader: a trace stored without `version` reads back unchanged
      // (version is an optional forward-compat anchor, ADR-0007 amendment).
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
      // A repeat verdict (double-tap, client retry) UPSERTS (thermo-review
      // A1): the 0003 functional unique index keys one verdict per
      // (user, answer, element), so the row count stays 1 and the latest
      // free text wins.
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
      // The rehydrated transcript carries the chat ROW id (store-generated),
      // not the trace's message_id — the target must resolve from both (#13).
      const byRowId = yield* store.getAnswerFeedbackTarget(chatRowId);
      const absentTarget = yield* store.getAnswerFeedbackTarget(crypto.randomUUID());
      // A non-uuid id can only ever be a message-id key (thermo-review A4):
      // it must degrade to a null target, never 500 at the `::uuid` cast.
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
    // The target carries the trace's CANONICAL message id (thermo-review A2)
    // — the id feedback rows are keyed by, whatever id the caller looked up.
    expect(target?.messageId).toBe(messageId);
    // The answer text joins through chat_messages.answer_trace_id (#13).
    expect(target?.answerText).toBe("Allah Mahahidup [QS. 2:255].");
    expect(byRowId).toEqual(target);
    expect(absentTarget).toBeNull();
    expect(nonUuidTarget).toBeNull();
    // The upsert kept the repeat verdict to one row with the latest free text.
    expect(thumbRows[0]?.n).toBe(1);
    // After the cascade the trace is gone; the token no longer resolves.
    expect(orphanedTarget).toBeNull();
    expect(deadToken).toBeNull();
  }, 60_000);

  it("upserts doc parents/children idempotently by source_key / (parent_id, ordinal)", async () => {
    if (!URL) return;
    const ar = vec(1536, 7);
    const program = Effect.gen(function* () {
      const parentId = yield* store.insertDocParent({
        sourceKey: `${PREFIX}-upsert`,
        title: "first",
        metadata: { pfx: PREFIX, rev: 1 },
      });
      // Re-insert the same source_key with different metadata/title → same id,
      // updated fields, no duplicate row.
      const parentId2 = yield* store.insertDocParent({
        sourceKey: `${PREFIX}-upsert`,
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
    expect(me?.child.textRaw).toBe("raw-immutable"); // rule 13: text_raw immutable
    expect(me?.child.textAr).toBe("ar-v2"); // derived layer refreshed
    expect(me?.child.citation).toEqual({ s: 3, a: 7 });
    expect(me?.child.metadata).toMatchObject({ rev: 2 });
  }, 60_000);

  /**
   * The neighbour read against real Postgres (#334).
   *
   * The fake-runner unit test pins this statement's *text*, which is exactly
   * how the shipped defect survived every gate: the `anchors` CTE projects
   * `a.id AS anchor_id`, the join predicate read `an.id`, and PostgreSQL
   * rejected the whole statement at parse time (`ERROR: column an.id does not
   * exist`) — so every chat request that reached this read answered 500 while
   * the SQL-text assertions stayed green. These rows assert the statement
   * EXECUTES and that its behaviour is the one ADR-0049 documents: each
   * anchor's ordinal window inside the anchor's own parent, the anchor never
   * its own neighbour, a neighbour reachable from several anchors deduplicated
   * onto the FIRST anchor in the caller's order, ordering by anchor position
   * then `ordinal` (the cap's truncation depends on it), and the radius/limit
   * bounds honoured.
   */
  describe("listDocChildNeighboursByChildIds (real Postgres, ADR-0049, #334)", () => {
    // Parent A carries ordinals 0..8 (wide enough for a radius-3 window with
    // room on both sides); parent B carries rows at some of the SAME ordinals,
    // so a window that leaked across the parent join would be visible.
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
          sourceKey: `${PREFIX}-neigh-a`,
          title: parentTitle,
          metadata: { pfx: PREFIX },
        });
        at = yield* Effect.forEach(ORDINALS, (ordinal) => seed(parentId, ordinal));
        const otherParentId = yield* store.insertDocParent({
          sourceKey: `${PREFIX}-neigh-b`,
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
      // Exactly the two ordinal neighbours, in ordinal order. Pre-fix this
      // call rejected the statement (`column an.id does not exist`).
      expect(rows.map((r) => r.id)).toEqual([at[2], at[4]]);
      // The anchor is never returned as its own neighbour (decision 2).
      expect(rows.map((r) => r.id)).not.toContain(at[3]);
      // And the window never crosses the parent join: parent B holds rows at
      // the same ordinals 2 and 4, and neither may appear here.
      expect(rows.map((r) => r.id)).not.toContain(otherAt.get(2));
      expect(rows.map((r) => r.id)).not.toContain(otherAt.get(4));
      // The mapped row carries the full read contract: the text layers, the
      // opaque citation, the parent's display title, and no vectors (the same
      // embedding-stripping contract as every other corpus read).
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
      // Radius 2 on ordinal 3 reaches one further on each side.
      expect((await read([at[3]!], 2, 10)).map((r) => r.id)).toEqual([at[1], at[2], at[4], at[5]]);
      // One step outside the radius stays out — the bound the radius is for.
      expect((await read([at[3]!], 1, 10)).map((r) => r.id)).not.toContain(at[1]);
      // The last ordinal has no rows beyond it: the window clamps rather than
      // failing or inventing rows.
      expect((await read([at[8]!], 3, 10)).map((r) => r.id)).toEqual([at[5], at[6], at[7]]);
    }, 60_000);

    it("deduplicates a neighbour shared by two anchors onto the FIRST anchor, and orders by anchor position then ordinal", async () => {
      if (!URL) return;
      // Anchors at ordinals 2 and 5 with radius 3: ordinals 3 and 4 fall in
      // BOTH windows, so each must be attributed to the first anchor (2), and
      // the result groups anchor 2's window before anchor 5's. Ordinals 5 and
      // 2 below are the anchors inside the *other* anchor's window — the read
      // excludes an anchor from its own window only (decision 2's "never the
      // anchor"), and the domain expansion drops any id already in context.
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
      // The same read capped at four keeps anchor 2's window. Had the shared
      // neighbours (3 and 4) been attributed to the LATEST anchor instead, the
      // surviving four would be at[0], at[1], at[5], at[2] — a different set.
      // That difference is what "the caller's array order is the priority
      // order" buys ADR-0049's cap.
      expect((await read([at[2]!, at[5]!], 3, 4)).map((r) => r.id)).toEqual([
        at[0],
        at[1],
        at[3],
        at[4],
      ]);
      // The priority order is the caller's array order, NOT the anchors'
      // ordinal order: the same two anchors reversed spend the cap on the
      // other window.
      expect((await read([at[5]!, at[2]!], 3, 4)).map((r) => r.id)).toEqual([
        at[2],
        at[3],
        at[4],
        at[6],
      ]);
      // A limit of one returns exactly the first row of that order.
      expect((await read([at[4]!], 2, 2)).map((r) => r.id)).toEqual([at[2], at[3]]);
    }, 60_000);

    it("drops an anchor id no stored row backs, without failing the read", async () => {
      if (!URL) return;
      // A retrieved id with no row behind it cannot anchor a window (the CTE's
      // join drops it); the read stays a read and the known anchor still
      // returns its own window.
      expect((await read([crypto.randomUUID(), at[1]!], 1, 10)).map((r) => r.id)).toEqual([
        at[0],
        at[2],
      ]);
    }, 60_000);
  });
});
