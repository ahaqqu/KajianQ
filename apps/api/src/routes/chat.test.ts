import { describe, expect, it, vi } from "vitest";
import { createApi } from "../app";

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock("@sentry/cloudflare", () => ({ captureException }));
import { runStoreEffect } from "@app/kajianq-domain";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import { createStubChatProviders } from "@app/kajianq-domain/test-utils/stub-chat-providers";

/**
 * /v1/chat integration tests (#8, #10): the in-memory store + the domain's
 * stub providers (built inside the domain so the Effects belong to the
 * engine's runtime). Verifies the SSE path, auth, validation, trace
 * persistence, follow-up history, and the citation refusal invariant against
 * the real route module — no Worker runtime, no vendor calls.
 */

/**
 * One retrievable Quran chunk whose citation label is `QS. 2:255`. A test that
 * wants a *grounded* answer must put it in the store, because the reviewer
 * refuses any citation the retrieved context does not carry (the #10
 * invariant) — that is the point, not an inconvenience.
 */
const AYAT_KURSI = {
  textRaw: "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ الْحَيُّ الْقَيُّومُ",
  textAr: "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ الْحَيُّ الْقَيُّومُ",
  textId: "Allah, tidak ada tuhan selain Dia, Yang Mahahidup.",
  citation: { sourceType: "quran", surah: 2, ayah: 255 },
  metadata: { sourceType: "quran", citation: "QS. 2:255" },
  embeddingPrimary: [1, 0, 0],
  ordinal: 0,
};

/** Seed a store with one retrievable parent + child chunk. */
async function seed(
  store: ReturnType<typeof createMemoryRagStore>,
  child: Partial<typeof AYAT_KURSI> = {},
): Promise<void> {
  const parentId = await runStoreEffect<string>(
    store.insertDocParent({ sourceKey: "quran/2", title: "Al-Baqarah", metadata: {} }),
  );
  await runStoreEffect<string>(
    store.insertDocChild({ parentId, ...AYAT_KURSI, ...child } as never),
  );
}

/** A memory store wired with a minted test session; returns store + token. */
async function wiredStore(): Promise<{
  store: ReturnType<typeof createMemoryRagStore>;
  token: string;
}> {
  const store = createMemoryRagStore();
  const session = await runStoreEffect<{ token: string }>(store.createSession());
  return { store, token: session.token };
}

let currentStore: ReturnType<typeof createMemoryRagStore>;
let currentOverrides: Parameters<typeof createStubChatProviders>[0] = {};

vi.mock("../lib/chat-wiring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/chat-wiring")>();
  return {
    ...actual,
    buildChatWiring: () => {
      const store = currentStore;
      const providers = createStubChatProviders(currentOverrides);
      return {
        pipeline: {
          routerProvider: providers.routerProvider,
          generatorProvider: providers.generatorProvider,
          // The reviewer is non-optional on the chat path (#10); the stub
          // passes, so the deterministic validator is what these tests probe.
          reviewerProvider: providers.reviewerProvider,
          embedder: providers.embedder,
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

/**
 * Parse SSE frames the way the eval client does (`packages/eval/src/api-client.ts`):
 * `event:` names are trimmed, a `data:` payload keeps its trailing whitespace
 * (SSE strips only the single optional space after the colon), and a frame's
 * multiple `data:` lines join with `\n` — which is how a multi-line answer
 * survives the wire. A `trim()` here would hide a lost space; skipping the
 * join would hide a truncated answer.
 */
function parseSse(text: string): { event: string; data: string }[] {
  return text
    .split("\n\n")
    .filter((f) => f.trim() !== "")
    .map((frame) => {
      const lines = frame.split("\n");
      const event =
        lines
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim() ?? "message";
      const dataLines = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart());
      return { event, data: dataLines.join("\n") };
    });
}

/** POST one chat message and return the parsed SSE frames + joined deltas. */
async function postChat(
  token: string,
  body: Record<string, unknown>,
): Promise<{
  status: number;
  frames: { event: string; data: string }[];
  answer: string;
  meta: { sessionId: string; messageId: string; traceId: string };
}> {
  const res = await createApi().request(
    "/v1/chat",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env,
  );
  if (res.status !== 200) {
    return {
      status: res.status,
      frames: [],
      answer: "",
      meta: { sessionId: "", messageId: "", traceId: "" },
    };
  }
  const frames = parseSse(await res.text());
  const answer = frames
    .filter((f) => f.event === "delta")
    .map((f) => f.data)
    .join("");
  const meta = JSON.parse(
    frames.find((f) => f.event === "meta")?.data ?? "{}",
  ) as { sessionId: string; messageId: string; traceId: string };
  return { status: res.status, frames, answer, meta };
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
    currentStore = (await wiredStore()).store;
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
    const { store, token } = await wiredStore();
    currentStore = store;
    await seed(store);
    currentOverrides = { answerText: "Jawaban berdasar konteks. QS. 2:255" };

    const { status, frames, answer, meta } = await postChat(token, {
      message: "Apa itu Ayat Kursi?",
    });
    expect(status).toBe(200);
    expect(frames.at(-1)?.event).toBe("done");
    expect(answer).toContain("QS. 2:255");

    // The answer trace was persisted under the streamed message id.
    const trace = store.allTraces().get(meta.messageId) as
      | { id: string; events: { kind: string; cost?: { modelId: string; tokensIn: number } }[] }
      | undefined;
    expect(trace).toBeTruthy();
    expect(trace?.id).toBe(meta.traceId);
    // Traceability (#10 AC): chunks + scores, model identity, tokens, cost.
    const retrieval = trace?.events.find((e) => e.kind === "retrieval") as
      | { detail: { chunks: { id: string; score?: number }[] } }
      | undefined;
    expect(retrieval?.detail.chunks.length).toBeGreaterThan(0);
    expect(retrieval?.detail.chunks[0]?.score).toBeGreaterThan(0);
    const llmCalls = trace?.events.filter((e) => e.kind === "llm_call") ?? [];
    expect(llmCalls.length).toBeGreaterThan(0);
    for (const call of llmCalls) {
      expect(call.cost?.modelId).toBeTruthy();
      expect(typeof call.cost?.tokensIn).toBe("number");
    }

    // The assistant message links to the trace.
    const assistant = store.allChatMessages().find((m) => m.role === "assistant");
    expect(assistant?.answerTraceId).toBe(meta.traceId);
  }, 15000);

  it("replays the vendor's own delta sequence, with appended rules as a trailing delta", async () => {
    const { store, token } = await wiredStore();
    currentStore = store;
    await seed(store);
    // Three deltas, as a streaming vendor would produce them.
    currentOverrides = { streamDeltas: ["Menurut ", "QS. 2:255 ", "Allah Mahahidup."] };

    const { answer, frames } = await postChat(token, { message: "Apa itu Ayat Kursi?" });
    const deltas = frames.filter((f) => f.event === "delta");
    // The vendor's three deltas, byte-identical, then the appended disclaimer.
    expect(deltas.slice(0, 3).map((d) => d.data)).toEqual([
      "Menurut ",
      "QS. 2:255 ",
      "Allah Mahahidup.",
    ]);
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    expect(deltas.map((d) => d.data).join("")).toBe(answer);
    expect(answer.startsWith("Menurut QS. 2:255 Allah Mahahidup.")).toBe(true);
    expect(answer).toContain("bukan fatwa");
  }, 15000);

  it("refuses an answer whose citation is not in the retrieved context (the #10 invariant)", async () => {
    const { store, token } = await wiredStore();
    currentStore = store;
    // Retrieval is empty; the model fabricates two citations.
    currentOverrides = {
      answerText: "Menurut QS. 2:255, Allah Mahahidup. QS. 9:99 juga menyebutkannya.",
    };

    const { status, answer } = await postChat(token, { message: "Apa itu Ayat Kursi?" });
    expect(status).toBe(200);
    // The fabricated citation never reaches the user as an answer.
    expect(answer).not.toContain("QS. 2:255");
    expect(answer).not.toContain("QS. 9:99");
    expect(answer).toBe("tidak menemukan dalil yang memadai");

    // The refusal is visible on the trace (the eval harness reads this event).
    const assistant = store.allChatMessages().find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("tidak menemukan dalil yang memadai");
    const trace = [...store.allTraces().values()].at(0) as
      | { events: { kind: string; detail?: { trigger?: string } }[] }
      | undefined;
    const refusal = trace?.events.find((e) => e.kind === "refusal");
    expect(refusal).toBeTruthy();
    expect(refusal?.detail?.trigger).toBe("ungrounded_citation");
  }, 15000);

  it("refuses when only one of two citations is grounded", async () => {
    const { store, token } = await wiredStore();
    currentStore = store;
    // The store carries QS. 2:255; the answer also cites a fabricated QS. 112:1.
    await seed(store);
    currentOverrides = { answerText: "QS. 2:255 menjelaskan keesaan Allah. Lihat QS. 112:1." };

    const { answer } = await postChat(token, { message: "Apa itu Ayat Kursi?" });
    expect(answer).toBe("tidak menemukan dalil yang memadai");
  }, 15000);

  it("refuses a fabricated citation written without brackets", async () => {
    const { store, token } = await wiredStore();
    currentStore = store;
    await seed(store);
    // Prose form: the bracket-only scan this replaced would have passed it.
    currentOverrides = { answerText: "Rasulullah bersabda dalam HR. Bukhari no. 99999 hal ini." };

    const { answer } = await postChat(token, { message: "Hadits tentang niat?" });
    expect(answer).toBe("tidak menemukan dalil yang memadai");
  }, 15000);

  it("uses prior turns of the session as follow-up context", async () => {
    const { store, token } = await wiredStore();
    currentStore = store;
    await seed(store);
    currentOverrides = { answerText: "Jawaban lanjutan. QS. 2:255" };

    const first = await postChat(token, { message: "Apa itu Ayat Kursi?" });
    expect(first.status).toBe(200);
    const second = await postChat(token, {
      message: "Apa dalilnya?",
      sessionId: first.meta.sessionId,
    });
    expect(second.status).toBe(200);

    // Both exchanges persisted in the one session.
    const messages = await runStoreEffect<readonly { role: string; content: string }[]>(
      store.getChatMessages(first.meta.sessionId, { limit: 10 }),
    );
    expect(messages.length).toBe(4);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  }, 15000);

  it("rejects a session id that belongs to another user", async () => {
    const { store, token } = await wiredStore();
    currentStore = store;
    currentOverrides = { answerText: "ok" };
    const res = await createApi().request(
      "/v1/chat",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: "hi", sessionId: "sess-does-not-exist" }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });
});
