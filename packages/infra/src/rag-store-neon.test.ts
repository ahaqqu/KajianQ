/// <reference types="node" />
import { neon } from "@neondatabase/serverless";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createNeonRagStore } from "./rag-store-neon";
import type { RagStore } from "./rag-store";

/**
 * RagStore contract tests (#4 AC: "vector insert + similarity query
 * round-trip on both `embedding_primary` and `embedding_fallback`").
 *
 * These are integration tests against a real Neon database. They only run
 * when NEON_DATABASE_URL is set — without it they are skipped so unit-test
 * runs (and any environment lacking the secret) stay green. When the URL is
 * present they must be run in SERIES (`vitest --no-file-parallelism` or a
 * single-file run) because they share one test fixture namespace keyed off a
 * per-run prefix; parallel runs against the same Neon project would race.
 *
 * Assertions are Effect-shaped (ADR-0027 decision 7): every seam call is
 * composed into one program per test via `Effect.gen`/`Effect.forEach` and
 * run with a single `Effect.runPromise` at the test's edge — the suite
 * exercises the seam as the seam is now shaped, not through per-call promise
 * shims.
 */

const URL = process.env.NEON_DATABASE_URL;
const run = URL ? describe : describe.skip;

// Per-run prefix isolates this test run's rows from anything else in the
// staging database, so the tests are idempotent and leave no residue.
let PREFIX: string;
let store: RagStore;
let cleanup: () => Promise<void>;

function vec(dim: number, seed: number): number[] {
  return Array.from({ length: dim }, (_, i) => Math.sin(seed * 1000 + i * 0.01));
}

run("RagStore contract (real Neon, Effect-shaped seam)", () => {
  beforeAll(async () => {
    if (!URL) return;
    PREFIX = `ct-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const sql = neon(URL);
    store = createNeonRagStore(sql);
    cleanup = async () => {
      // Remove this run's fixture rows. userId/messageId keys carry PREFIX so
      // a failed run cannot collide with the next.
      await sql`DELETE FROM users WHERE id IN (
        SELECT user_id FROM chat_sessions WHERE metadata->>'pfx' = ${PREFIX}
      )`;
      await sql`DELETE FROM answer_traces WHERE message_id LIKE ${PREFIX + "-%"}`;
      await sql`DELETE FROM doc_parents WHERE source_key = ${PREFIX}`;
    };
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
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
    expect(hits[0]?.child.embeddingPrimary).toHaveLength(1536);
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
});
