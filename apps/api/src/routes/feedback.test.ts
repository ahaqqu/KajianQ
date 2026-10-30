import { describe, expect, it, vi } from "vite-plus/test";
import { createApi } from "../app";
import { parseFeedbackRequest } from "../lib/feedback";
import { STORABLE_TEXT_PATTERN, type Trace } from "@app/contracts";
import { runStoreEffect } from "@app/kajianq-domain";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import { createMemoryRateLimiter } from "@app/rate";

/**
 * POST /v1/feedback integration tests over the real route with the in-memory store.
 * The traps are the silent-failure shapes: a flag whose anchor the trace does not
 * ground is a 422 and NOT a stored row; a foreign answer is an indistinguishable 404;
 * a body that is neither thumb nor flag (or both) fails the contract before the store.
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

// The database client lives behind the RagStore adapter, so these tests never
// reach one: this mock makes a pool query loud.
vi.mock("pg", () => ({
  Pool: class {
    on(): void {}
    query(): never {
      throw new Error("feedback test: the database must not be reached");
    }
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
 * QS. 2:256; the first carries a translation layer and optionally a grade), a
 * trace referencing them, an optional `chain_evidence` record for the first
 * chunk, and an assistant message citing both labels.
 */
async function seedAnswer(
  store: ReturnType<typeof createMemoryRagStore>,
  userId: string,
  opts: { chunkCount?: number; grade?: string; chains?: { grade: string; grader: string }[] } = {},
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
          // Only the first chunk carries the translation layer.
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
  const trace: Trace = {
    id: `trace-${crypto.randomUUID()}`,
    createdAt: 1_700_000_000_000,
    events: [
      {
        stage: "retriever" as const,
        kind: "retrieval" as const,
        detail: { chunks: chunkIds.map((id) => ({ id, score: 0.1 })) },
        at: 1_700_000_000_100,
      },
      ...(opts.chains === undefined
        ? []
        : [
            {
              stage: "retriever" as const,
              kind: "chain_evidence" as const,
              detail: {
                consulted: 1,
                perChildCap: 8,
                children: [
                  {
                    childId: chunkIds[0]!,
                    chains: opts.chains.map((chain) => ({
                      narratorIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
                      ...chain,
                    })),
                  },
                ],
                missingNarratorIds: [],
              },
              at: 1_700_000_000_200,
            },
          ]),
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

  it("names the offending field in the logged 400 diagnostic (#283)", async () => {
    // The DETAIL makes the refusal diagnosable in ops, names the field that failed, and
    // never stringifies a valibot path item as `[object Object]`.
    const warnings: string[] = [];
    const parsed = await parseFeedbackRequest(
      new Request("http://localhost/v1/feedback", {
        method: "POST",
        body: JSON.stringify({ messageId: "msg1", rating: "up" }),
      }),
      { warn: (msg, fields) => warnings.push(`${msg} ${JSON.stringify(fields ?? {})}`) },
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error).toBe("invalid_request");
    expect(parsed.detail).toContain("messageId");
    expect(parsed.detail).not.toContain("[object Object]");
    expect(warnings.join(" ")).toContain("messageId");
  });

  it("names the field behind a union failure too (thermo A1)", async () => {
    // `rating: "meh"` fails the thumb/flag union structurally: valibot reports ONE
    // path-less `union` issue whose nested `issues` carry the real path, so the detail
    // must descend into them. The response body and status for this payload are unchanged.
    const warnings: string[] = [];
    const parsed = await parseFeedbackRequest(
      new Request("http://localhost/v1/feedback", {
        method: "POST",
        body: JSON.stringify({
          messageId: "550e8400-e29b-41d4-a716-446655440000",
          rating: "meh",
        }),
      }),
      { warn: (msg, fields) => warnings.push(`${msg} ${JSON.stringify(fields ?? {})}`) },
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error).toBe("invalid_request");
    expect(parsed.detail).toContain("rating");
    expect(parsed.detail).not.toContain("[object Object]");
    expect(warnings.join(" ")).toContain("rating");
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

  it("anchors a questionable grade to the chain row the reader disputed", async () => {
    const { store, userId, token } = await wiredStore();
    const messageId = await seedAnswer(store, userId, {
      grade: "sahih",
      chains: [
        { grade: "sahih", grader: "al-bukhari" },
        { grade: "dhaif", grader: "al-daraqutni" },
      ],
    });
    const second = {
      type: "chain",
      category: "questionable_grade",
      id: "QS. 2:255",
      chainIndex: 1,
      grade: "dhaif",
      grader: "al-daraqutni",
    };
    const first = { ...second, chainIndex: 0, grade: "sahih", grader: "al-bukhari" };
    const res = await post(token, { messageId, anchor: second });
    const other = await post(token, { messageId, anchor: first });
    expect(res.status).toBe(200);
    expect(other.status).toBe(200);
    // Each row's complaint is its own record: the stored id must distinguish the
    // two rows or the review queue cannot tell which sanad was disputed.
    const rows = store.allFeedback();
    expect(rows.map((row) => [row.anchorType, row.anchorId])).toEqual([
      ["chain", "QS. 2:255#chain:1"],
      ["chain", "QS. 2:255#chain:0"],
    ]);
    // The response echoes the anchor the client sent, position and verdict included.
    expect((await res.json()).anchor).toEqual(second);
    // A row's own verdict is part of the anchor: an index that points at a dhaif
    // row while claiming sahih is rejected, never stored.
    for (const anchor of [
      { ...second, grade: "sahih", grader: "al-bukhari" },
      { ...second, chainIndex: 9 },
      { type: "grade", category: "questionable_grade", id: "QS. 2:255" },
    ]) {
      const rejected = await post(token, { messageId, anchor });
      expect(rejected.status).toBe(422);
    }
    expect(store.allFeedback()).toHaveLength(2);
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

  // A repeat verdict updates the one row in place, never multiplying review rows,
  // and answers with the id of that row.
  it("upserts a repeated verdict: one row per (user, answer, element), latest wins, same id", async () => {
    const { store, userId, token } = await wiredStore();
    const messageId = await seedAnswer(store, userId);
    const first = await post(token, { messageId, rating: "up" });
    const firstBody = (await first.json()) as { id: string };
    const again = await post(token, { messageId, rating: "up", freeText: "second tap" });
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { id: string };
    const changed = await post(token, { messageId, rating: "down" });
    expect(changed.status).toBe(200);
    const changedBody = (await changed.json()) as { id: string };
    expect(againBody.id).toBe(firstBody.id);
    expect(changedBody.id).toBe(firstBody.id);
    const rows = store.allFeedback();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId, messageId, rating: -1, anchorType: "answer" });
    expect(rows[0]?.id).toBe(firstBody.id);
    expect(rows.filter((row) => row.id === firstBody.id)).toHaveLength(1);
  });

  it("upserts a repeated flag on the same element without a sibling row, same id", async () => {
    const { store, userId, token } = await wiredStore();
    const messageId = await seedAnswer(store, userId);
    const target = store.allChildren()[0]?.id as string;
    const anchor = { type: "chunk", category: "irrelevant_chunk", id: target };
    const first = await post(token, { messageId, anchor, freeText: "first" });
    const firstBody = (await first.json()) as { id: string };
    const second = await post(token, { messageId, anchor, freeText: "second" });
    const secondBody = (await second.json()) as { id: string };
    expect(secondBody.id).toBe(firstBody.id);
    expect(store.allFeedback()).toHaveLength(1);
    expect(store.allFeedback()[0]).toMatchObject({ id: firstBody.id, freeText: "second" });
  });

  // A different anchor is a different row: the conflict key includes the anchor
  // element, so flagging a second chunk of the same answer must not overwrite the
  // first flag's id (and re-flagging the first answers its own row again).
  it("answers a different id for a different chunk anchor of the same answer", async () => {
    const { store, userId, token } = await wiredStore();
    const messageId = await seedAnswer(store, userId, { chunkCount: 2 });
    const chunkA = store.allChildren()[0]?.id as string;
    const chunkB = store.allChildren()[1]?.id as string;
    const anchorA = { type: "chunk", category: "irrelevant_chunk", id: chunkA };
    const anchorB = { type: "chunk", category: "irrelevant_chunk", id: chunkB };
    const first = await post(token, { messageId, anchor: anchorA });
    const other = await post(token, { messageId, anchor: anchorB });
    expect(first.status).toBe(200);
    expect(other.status).toBe(200);
    const firstId = ((await first.json()) as { id: string }).id;
    const otherId = ((await other.json()) as { id: string }).id;
    expect(otherId).not.toBe(firstId);
    expect(store.allFeedback()).toHaveLength(2);
    // Re-flagging the first chunk answers its original row, not a third.
    const again = await post(token, { messageId, anchor: anchorA });
    expect(((await again.json()) as { id: string }).id).toBe(firstId);
    expect(store.allFeedback()).toHaveLength(2);
  });

  it("documents the response id's repeat invariant once, pointing the 200 at it", async () => {
    const api = createApi();
    const res = await api.request("/openapi.json", {}, env);
    expect(res.ok).toBe(true);
    const doc = (await res.json()) as {
      paths: Record<
        string,
        {
          post: {
            responses: Record<
              string,
              {
                description?: string;
                content: Record<
                  string,
                  { schema: { properties?: Record<string, { description?: string }> } }
                >;
              }
            >;
          };
        }
      >;
    };
    const ok = doc.paths["/v1/feedback"]?.post.responses["200"];
    expect(ok?.description).toContain("stored feedback row");
    expect(ok?.description).toContain("(canonical: `FeedbackResponseSchema.id`)");
    const id = ok?.content["application/json"]?.schema.properties?.id;
    expect(id?.description).toContain("stored feedback row's id");
    expect(id?.description).toContain("a different anchor is a different row");
  });

  // A rehydrated transcript addresses the answer by the chat ROW id, a live surface by
  // the trace's message id: both land on the same canonically-keyed row.
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
    await post(token, { messageId, rating: "up" });
    expect(store.allFeedback()).toHaveLength(1);
  });

  it("answers 400 invalid_request to a free text the store cannot hold, and writes nothing (#510)", async () => {
    const { store, userId, token } = await wiredStore();
    const messageId = await seedAnswer(store, userId);
    for (const freeText of ["\u0000", "\u0000riba", "riba\u0000", "\ud800", "\udc00"]) {
      const res = await post(token, { messageId, rating: "up", freeText });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
    // Validation runs before auth: an unauthenticated NUL body is refused as a
    // body, never answered with the missing-session 401.
    const noAuth = await post(null, { messageId, rating: "up", freeText: "\u0000" });
    expect(noAuth.status).toBe(400);
    expect(store.allFeedback()).toHaveLength(0);
  });

  it("still stores the free text the store can hold, control characters included (#510)", async () => {
    const { store, userId, token } = await wiredStore();
    const messageId = await seedAnswer(store, userId);
    for (const freeText of ["tidak relevan", "\u0001\u0007", "😀"]) {
      const res = await post(token, { messageId, rating: "up", freeText });
      expect(res.status).toBe(200);
      expect(store.allFeedback()[0]).toMatchObject({ freeText });
    }
  });

  it("documents the free-text storability rule as the pattern the route enforces (#510)", async () => {
    const api = createApi();
    const res = await api.request("/openapi.json", {}, env);
    expect(res.ok).toBe(true);
    const doc = (await res.json()) as {
      paths: Record<
        string,
        { post: { requestBody: { content: Record<string, { schema: { anyOf?: unknown } }> } } }
      >;
    };
    const schema = doc.paths["/v1/feedback"]?.post.requestBody.content["application/json"]?.schema;
    const shapes = (schema?.anyOf ?? []) as {
      properties: { freeText?: { pattern?: string; maxLength?: number; description?: string } };
    }[];
    expect(shapes).toHaveLength(2);
    for (const { properties } of shapes) {
      expect(properties.freeText?.pattern).toBe(STORABLE_TEXT_PATTERN);
      const published = new RegExp(properties.freeText?.pattern ?? "(?!)");
      expect(published.test("\u0000")).toBe(false);
      expect(published.test("\ud800")).toBe(false);
      expect(published.test("tidak relevan")).toBe(true);
      // `maxLength` counts code points, the route's cap counts UTF-16 code
      // units; the description is the only place the document can state which
      // unit a client must measure against the cap.
      expect(properties.freeText?.maxLength).toBe(2000);
      expect(properties.freeText?.description).toContain("UTF-16 code units");
      expect(properties.freeText?.description).toContain("no trim");
      expect(properties.freeText?.description).toContain("U+0000");
      expect(properties.freeText?.description).toContain("unpaired surrogate");
    }
  });

  it("documents the one-shape invariant in /openapi.json, not only at runtime", async () => {
    // The emitted document must carry the same rule the route enforces — a union of two
    // shapes, each forbidding the sibling key — so a compliant probe is never answered 400.
    const api = createApi();
    const res = await api.request("/openapi.json", {}, env);
    expect(res.ok).toBe(true);
    const doc = (await res.json()) as {
      paths: Record<
        string,
        { post: { requestBody: { content: Record<string, { schema: { anyOf?: unknown } }> } } }
      >;
    };
    const op = doc.paths["/v1/feedback"]?.post;
    expect(op).toBeDefined();
    const media = op?.requestBody.content["application/json"];
    expect(media).toBeDefined();
    const schema = media?.schema;
    expect(schema).toBeDefined();
    const shapes = (schema?.anyOf ?? []) as {
      properties: Record<string, unknown>;
      required: string[];
    }[];
    expect(shapes).toHaveLength(2);
    const thumb = shapes.find((s) => s.required.includes("rating"));
    const flag = shapes.find((s) => s.required.includes("anchor"));
    // Each shape emits a `not` clause on the sibling key — the XOR.
    expect(thumb?.properties.anchor).toEqual({ not: {} });
    expect(flag?.properties.rating).toEqual({ not: {} });
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
