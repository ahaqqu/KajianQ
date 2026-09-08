import { describe, expect, it, vi } from "vitest";
import { createApi } from "../app";

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock("@sentry/cloudflare", () => ({ captureException }));
import { runStoreEffect } from "@app/kajianq-domain";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import { createStubChatProviders } from "@app/kajianq-domain/test-utils/stub-chat-providers";

/**
 * /v1/chat integration tests (#8): the in-memory store + the domain's stub
 * providers (built inside the domain so the Effects belong to the engine's
 * runtime). Verifies the SSE path, auth, validation, and trace persistence
 * against the real route module — no Worker runtime, no vendor calls.
 */

/** The memory store whose fixed test session token the auth guard accepts. */
async function wiredStore() {
  const store = createMemoryRagStore();
  // Mint one session so `resolveUserId("tok1")` resolves (the store's test
  // token convention: the first minted user owns the fixed token).
  await runStoreEffect(store.createSession());
  return store;
}

let currentStore: ReturnType<typeof createMemoryRagStore>;

vi.mock("../lib/chat-wiring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/chat-wiring")>();
  return {
    ...actual,
    buildChatWiring: () => {
      const store = currentStore;
      return {
        pipeline: {
          ...createStubChatProviders({
            answerText: "Jawaban berdasar konteks. QS. 2:255",
          }),
          reviewerProvider: null,
          store,
          bridge: runStoreEffect,
        },
        fullStore: store,
        runStore: runStoreEffect,
      };
    },
  };
});

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    throw new Error("chat test: neon must not be reached");
  },
}));

const env = { ASSETS: { fetch } };

function parseSse(text: string): { event: string; data: string }[] {
  return text
    .split("\n\n")
    .filter((f) => f.trim() !== "")
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "message";
      const data = lines.find((l) => l.startsWith("data:"))?.slice(5).trim() ?? "";
      return { event, data };
    });
}

describe("POST /v1/chat", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await createApi().request(
      "/v1/chat",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects an invalid body with 400", async () => {
    currentStore = await wiredStore();
    const res = await createApi().request(
      "/v1/chat",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok1" },
        body: JSON.stringify({ message: "" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("answers with an SSE stream and persists the trace", async () => {
    const store = await wiredStore();
    currentStore = store;
    const res = await createApi().request(
      "/v1/chat",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok1" },
        body: JSON.stringify({ message: "Apa itu Ayat Kursi?" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const frames = parseSse(await res.text());
    const meta = frames.find((f) => f.event === "meta");
    const delta = frames.find((f) => f.event === "delta");
    expect(frames.at(-1)?.event).toBe("done");
    expect(delta?.data).toContain("QS. 2:255");
    expect(meta).toBeTruthy();

    const metaPayload = JSON.parse(meta?.data ?? "{}") as { messageId: string; traceId: string };
    // The answer trace was persisted under the streamed message id.
    const trace = store.allTraces().get(metaPayload.messageId) as
      | { id: string; events: { kind: string }[] }
      | undefined;
    expect(trace).toBeTruthy();
    expect(trace?.id).toBe(metaPayload.traceId);
    expect(trace?.events.some((e) => e.kind === "llm_call")).toBe(true);

    // The assistant message links to the trace.
    const assistant = store.allChatMessages().find((m) => m.role === "assistant");
    expect(assistant?.answerTraceId).toBe(metaPayload.traceId);
  }, 15000);
});
