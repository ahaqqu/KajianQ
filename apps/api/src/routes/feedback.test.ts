import { describe, expect, it, vi } from "vitest";
import { createApi } from "../app";
import { runStoreEffect } from "@app/kajianq-domain";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import { createMemoryRateLimiter } from "@app/rate";

/**
 * POST /v1/feedback (#13): integration tests over the real route with the
 * in-memory store. The traps here are the silent-failure shapes: a flag whose
 * anchor the persisted trace does not ground must be a 422 and NOT a stored
 * row; a foreign answer must be an indistinguishable 404; a payload that is
 * neither thumb nor flag (or both) must fail the contract, never reach the
 * store.
 */

let currentStore: ReturnType<typeof createMemoryRagStore>;

vi.mock("../lib/chat-wiring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/chat-wiring")>();
  return {
    ...actual,
    buildStoreWiring: () => ({
      fullStore: currentStore,
      runStore: runStoreEffect,
    }),
  };
});

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    throw new Error("feedback test: neon must not be reached");
  },
}));

const env = { ASSETS: { fetch } };

const ARABIC = "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ";

async function wiredStore() {
  const store = createMemoryRagStore();
  const session = await runStoreEffect<{ userId: string; token: string }>(store.createSession());
  currentStore = store;
  return { store, userId: session.userId, token: session.token };
}

/**
 * Seed one answer owned by `userId`: `chunkCount` chunks (labels QS. 2:255,
 * QS. 2:256; the first carries a translation layer, optionally a grade), a
 * trace referencing them, and an assistant message citing both labels.
 */
async function seedAnswer(
  store: ReturnType<typeof createMemoryRagStore>,
  userId: string,
  opts: { chunkCount?: number; grade?: string } = {},
): Promise<string> {
  const sessionId = await runStoreEffect<string>(store.createChatSession({ userId }));
  const parentId = await runStoreEffect<string>(
    store.insertDocParent({
      sourceKey: `src-${crypto.randomUUID()}`,
      title: "Al-Baqarah",
      metadata: {},
    }),
  );
  const chunkCount = opts.chunkCount ?? 1;
  const chunkIds: string[] = [];
  for (let i = 0; i < chunkCount; i += 1) {
    chunkIds.push(
      await runStoreEffect<string>(
        store.insertDocChild({
          parentId,
          embeddingPrimary: null,
          embeddingFallback: null,
          textRaw: ARABIC,
          textAr: ARABIC,
          // Only the first chunk carries the translation layer (ADR-0013
          // display track) — the layer the translation flag validates against.
          textId: i === 0 ? "Allah, tidak ada tuhan selain Dia." : null,
          metadata: {
            sourceType: "quran",
            citation: `QS. 2:${255 + i}`,
            ...(opts.grade !== undefined && i === 0 ? { grade: opts.grade } : {}),
          },
          ordinal: i,
        }),
      ),
    );
  }
  const trace = {
    id: `trace-${crypto.randomUUID()}`,
    createdAt: 1_700_000_000_000,
    events: [
      {
        stage: "retriever" as const,
        kind: "retrieval" as const,
        detail: { chunks: chunkIds.map((id) => ({ id, score: 0.1 })) },
        at: 1_700_000_000_100,
      },
    ],
  };
  const messageId = crypto.randomUUID();
  await runStoreEffect<string>(store.insertAnswerTrace({ messageId, userId, trace }));
  await runStoreEffect<string>(
    store.insertChatMessage({
      sessionId,
      role: "assistant",
      content:
        chunkCount > 1
          ? "Allah Mahahidup [QS. 2:255]. Dia Maha Tunggal [QS. 2:256]."
          : "Allah Mahahidup [QS. 2:255].",
      answerTraceId: trace.id,
    }),
  );
  return messageId;
}

async function post(
  token: string | null,
  body: Record<string, unknown>,
  opts: { limiter?: ReturnType<typeof createMemoryRateLimiter>; limit?: number } = {},
): Promise<Response> {
  const api = createApi(opts);
  return api.request(
    "/v1/feedback",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("POST /v1/feedback", () => {
  it("requires the anonymous session (401)", async () => {
    await wiredStore();
    const res = await post(null, { messageId: crypto.randomUUID(), rating: "up" });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed body: neither thumb nor flag, both, bad pairing, bad uuid", async () => {
    await wiredStore();
    const id = crypto.randomUUID();
    for (const body of [
      { messageId: id },
      {
        messageId: id,
        rating: "up",
        anchor: { type: "chunk", category: "irrelevant_chunk", id: "c1" },
      },
      { messageId: id, anchor: { type: "grade", category: "irrelevant_chunk", id: "c1" } },
      { messageId: "msg1", rating: "up" },
      { messageId: id, rating: "meh" },
    ]) {
      const res = await post("tok-x", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
  });

  it("answers 404 for an unknown answer, indistinguishably from a foreign one", async () => {
    const { store, token } = await wiredStore();
    const other = await runStoreEffect<{ userId: string }>(store.createSession());
    const foreignMessageId = await seedAnswer(store, other.userId);
    const res = await post(token, { messageId: crypto.randomUUID(), rating: "up" });
    const foreignRes = await post(token, { messageId: foreignMessageId, rating: "up" });
    expect(res.status).toBe(404);
    expect(foreignRes.status).toBe(404);
    expect(await res.json()).toEqual(await foreignRes.json());
    expect(store.allFeedback()).toHaveLength(0);
  });

  it("stores an anonymous thumb against the answer (anchor_type answer)", async () => {
    const { store, userId, token } = await wiredStore();
    const messageId = await seedAnswer(store, userId);
    const res = await post(token, { messageId, rating: "up" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rating: string; anchor: string | null; status: string };
    expect(body.rating).toBe("up");
    expect(body.anchor).toBeNull();
    expect(body.status).toBe("pending");
    const rows = store.allFeedback();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      messageId,
      rating: 1,
      anchorType: "answer",
      anchorId: null,
      category: null,
    });
  });

  it("stores a chunk flag anchored to a real trace chunk ref", async () => {
    const { store, userId, token } = await wiredStore();
    const messageId = await seedAnswer(store, userId, { chunkCount: 2 });
    // The second chunk is in the trace; its id is the anchor the panel showed.
    const target = store.allChildren()[1]?.id as string;
    const res = await post(token, {
      messageId,
      anchor: { type: "chunk", category: "irrelevant_chunk", id: target },
      freeText: "tidak relevan",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rating: string | null; anchor: { type: string } | null };
    expect(body.rating).toBe("down"); // a flag is negative feedback by definition
    expect(body.anchor).toEqual({ type: "chunk", category: "irrelevant_chunk", id: target });
    expect(store.allFeedback()[0]).toMatchObject({
      anchorType: "chunk",
      anchorId: target,
      category: "irrelevant_chunk",
      rating: -1,
      freeText: "tidak relevan",
    });
  });

  it("rejects a chunk flag whose id the trace does not reference (422, nothing stored)", async () => {
    const { store, userId, token } = await wiredStore();
    const messageId = await seedAnswer(store, userId);
    const res = await post(token, {
      messageId,
      anchor: { type: "chunk", category: "irrelevant_chunk", id: "chunk-not-in-trace" },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid_anchor" });
    expect(store.allFeedback()).toHaveLength(0);
  });

  it("stores citation/translation/grade flags anchored to labels the trace grounds", async () => {
    const { store, userId, token } = await wiredStore();
    const messageId = await seedAnswer(store, userId, { grade: "hasan" });
    for (const anchor of [
      { type: "citation", category: "wrong_citation", id: "QS. 2:255" },
      { type: "translation", category: "bad_machine_translation", id: "QS. 2:255" },
      { type: "grade", category: "questionable_grade", id: "QS. 2:255" },
    ]) {
      const res = await post(token, { messageId, anchor });
      expect(res.status).toBe(200);
    }
    expect(store.allFeedback().map((f) => f.anchorType)).toEqual([
      "citation",
      "translation",
      "grade",
    ]);
  });

  it("rejects a translation/grade flag on a cited label that lacks the layer (422)", async () => {
    const { store, userId, token } = await wiredStore();
    // QS. 2:256 IS cited and grounded, but its chunk has no translation layer.
    const messageId = await seedAnswer(store, userId, { chunkCount: 2 });
    for (const anchor of [
      { type: "translation", category: "bad_machine_translation", id: "QS. 2:256" },
      { type: "grade", category: "questionable_grade", id: "QS. 2:256" },
    ]) {
      const res = await post(token, { messageId, anchor });
      expect(res.status).toBe(422);
    }
    expect(store.allFeedback()).toHaveLength(0);
  });

  it("rejects a citation flag on a label the answer never cited (422)", async () => {
    const { store, userId, token } = await wiredStore();
    const messageId = await seedAnswer(store, userId, { chunkCount: 2 });
    const res = await post(token, {
      messageId,
      anchor: { type: "citation", category: "wrong_citation", id: "QS. 2:999" },
    });
    expect(res.status).toBe(422);
    expect(store.allFeedback()).toHaveLength(0);
  });

  it("is rate limited per-IP with the shared /v1 budget (429)", async () => {
    const { store, userId, token } = await wiredStore();
    const messageId = await seedAnswer(store, userId);
    const limiter = createMemoryRateLimiter();
    const first = await post(token, { messageId, rating: "up" }, { limiter, limit: 1 });
    expect(first.status).toBe(200);
    const second = await post(token, { messageId, rating: "up" }, { limiter, limit: 1 });
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "rate_limited" });
  });

  // Thermo-review A1: a repeat verdict (double-tap, client retry, changed
  // mind) must update the one row in place, never multiply review-queue rows.
  it("upserts a repeated verdict: one row per (user, answer, element), latest wins", async () => {
    const { store, userId, token } = await wiredStore();
    const messageId = await seedAnswer(store, userId);
    await post(token, { messageId, rating: "up" });
    const again = await post(token, { messageId, rating: "up", freeText: "second tap" });
    expect(again.status).toBe(200);
    const changed = await post(token, { messageId, rating: "down" });
    expect(changed.status).toBe(200);
    const rows = store.allFeedback();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId, messageId, rating: -1, anchorType: "answer" });
  });

  it("upserts a repeated flag on the same element without a sibling row", async () => {
    const { store, userId, token } = await wiredStore();
    const messageId = await seedAnswer(store, userId);
    const target = store.allChildren()[0]?.id as string;
    const anchor = { type: "chunk", category: "irrelevant_chunk", id: target };
    await post(token, { messageId, anchor, freeText: "first" });
    await post(token, { messageId, anchor, freeText: "second" });
    expect(store.allFeedback()).toHaveLength(1);
    expect(store.allFeedback()[0]).toMatchObject({ freeText: "second" });
  });

  // Thermo-review A2: a rehydrated transcript addresses the answer by the
  // chat ROW id, a live surface by the trace's message id — both must land on
  // the same canonically-keyed row, and the response echoes the canonical id.
  it("keys the row by the canonical trace message id even when addressed by the row id", async () => {
    const { store, userId, token } = await wiredStore();
    const messageId = await seedAnswer(store, userId);
    const chatRowId = store.allChatMessages().find((m) => m.role === "assistant")?.id as string;
    const res = await post(token, { messageId: chatRowId, rating: "up" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messageId: string };
    expect(body.messageId).toBe(messageId); // canonical, not the row id
    const rows = store.allFeedback();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.messageId).toBe(messageId);
    // The same verdict via the canonical key hits the SAME row (upsert).
    await post(token, { messageId, rating: "up" });
    expect(store.allFeedback()).toHaveLength(1);
  });
});

describe("POST /v1/feedback — degraded derivation (thermo-review A3)", () => {
  it("answers 503 anchor_unavailable when the answer text is reclaimed, never a 422", async () => {
    const { store, userId, token } = await wiredStore();
    // Seed a trace with NO chat message row: the answer text is gone, so the
    // citations frame cannot be derived honestly — a server-side condition.
    const trace = {
      id: `trace-${crypto.randomUUID()}`,
      createdAt: 1_700_000_000_000,
      events: [],
    };
    await runStoreEffect<string>(
      store.insertAnswerTrace({ messageId: crypto.randomUUID(), userId, trace }),
    );
    const messageId = store.allTraces().keys().next().value as string;
    const res = await post(token, {
      messageId,
      anchor: { type: "citation", category: "wrong_citation", id: "QS. 2:255" },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "anchor_unavailable" });
    expect(store.allFeedback()).toHaveLength(0);
  });
});
