/// <reference types="node" />
import { neon } from "@neondatabase/serverless";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNeonRagStore } from "./rag-store-neon";
import type { RagStore } from "./rag-store";

/**
 * RagStore contract tests (#4 AC: "vector insert + similarity query
 * round-trip on both `embedding_ar` and `embedding_id`").
 *
 * These are integration tests against a real Neon database. They only run
 * when NEON_DATABASE_URL is set — without it they are skipped so unit-test
 * runs (and any environment lacking the secret) stay green. When the URL is
 * present they must be run in SERIES (`vitest --no-file-parallelism` or a
 * single-file run) because they share one test fixture namespace keyed off a
 * per-run prefix; parallel runs against the same Neon project would race.
 */

const URL = process.env.NEON_DATABASE_URL;
const run = URL ? describe : describe.skip;

// Per-run prefix isolates this test run's rows from anything else in the
// staging database, so the tests are idempotent and leave no residue.
let PREFIX: string;
let store: RagStore;
let cleanup: () => Promise<void>;

function vec(dim: number, seed: number): number[] {
  return Array.from({ length: dim }, (_, i) =>
    Math.sin(seed * 1000 + i * 0.01),
  );
}

run("RagStore contract (real Neon)", () => {
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

  it("round-trips a vector insert + similarity search on embedding_ar", async () => {
    if (!URL) return;
    const ar = vec(1536, 1);
    const parentId = await store.insertDocParent({
      sourceKey: PREFIX,
      title: "contract-fixture",
      metadata: { pfx: PREFIX },
    });
    const childId = await store.insertDocChild({
      parentId,
      textRaw: "raw-fixture",
      textAr: "text-ar-fixture",
      textId: "text-id-fixture",
      citation: { s: 2, a: 255 },
      embeddingAr: ar,
      embeddingId: null,
      ordinal: 0,
      metadata: { pfx: PREFIX },
    });
    const hits = await store.similaritySearch("ar", ar, {
      limit: 5,
      filters: { pfx: PREFIX },
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.child.id).toBe(childId);
    expect(hits[0]?.distance ?? 1).toBeLessThan(1e-6);
    expect(hits[0]?.child.embeddingAr).toHaveLength(1536);
    expect(hits[0]?.child.citation).toEqual({ s: 2, a: 255 });
  }, 60_000);

  it("round-trips a vector insert + similarity search on embedding_id", async () => {
    if (!URL) return;
    const idEmb = vec(1536, 2);
    const arEmb = vec(1536, 3);
    const parentId = await store.insertDocParent({
      sourceKey: PREFIX,
      title: "contract-fixture-2",
      metadata: { pfx: PREFIX },
    });
    const childId = await store.insertDocChild({
      parentId,
      textRaw: "raw-fixture",
      textAr: "text-ar-fixture",
      textId: "text-id-fixture",
      embeddingAr: arEmb,
      embeddingId: idEmb,
      ordinal: 1,
      metadata: { pfx: PREFIX },
    });
    // Query the id track with the id embedding; nearest must be this row, and
    // the ar embedding stored on the same row must come back unchanged.
    const hits = await store.similaritySearch("id", idEmb, {
      limit: 5,
      filters: { pfx: PREFIX },
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.child.id).toBe(childId);
    expect(hits[0]?.distance ?? 1).toBeLessThan(1e-6);

    // And searching the SAME row's ar embedding on the ar track must find it
    // too — the two tracks are independently queryable.
    const arHits = await store.similaritySearch("ar", arEmb, {
      limit: 5,
      filters: { pfx: PREFIX },
    });
    expect(arHits.some((h) => h.child.id === childId)).toBe(true);
  }, 60_000);

  it("creates an anonymous session, resolves it by token, and cascade-deletes the user", async () => {
    if (!URL) return;
    const { userId, token, expiresAt } = await store.createSession();
    expect(expiresAt).toBeGreaterThan(Date.now());

    const resolved = await store.resolveUserId(token);
    expect(resolved).toBe(userId);

    const sessionId = await store.createChatSession({
      userId,
      metadata: { pfx: PREFIX },
    });
    await store.insertChatMessage({ sessionId, role: "user", content: "hi" });

    await store.deleteUserCascade(userId);
    expect(await store.resolveUserId(token)).toBeNull();
  }, 60_000);

  it("persists and reads back a @app/contracts Trace verbatim", async () => {
    if (!URL) return;
    const trace = {
      id: "trace-1",
      createdAt: 1_700_000_000_000,
      events: [
        {
          stage: "generator" as const,
          kind: "llm_call",
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
    await store.insertAnswerTrace({ messageId, trace });
    const fetched = await store.getAnswerTraceByMessage(messageId);
    expect(fetched).toEqual(trace);
    expect(await store.getAnswerTraceByMessage(`${PREFIX}-nope`)).toBeNull();
  }, 60_000);
});
