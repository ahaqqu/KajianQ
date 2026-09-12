import { describe, expect, it, vi } from "vitest";
import { createApi } from "../app";
import { runStoreEffect } from "@app/kajianq-domain";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import { createStubChatProviders } from "@app/kajianq-domain/test-utils/stub-chat-providers";

/**
 * GET /v1/chat/sessions/:id/messages (#11, ADR-0040): the rehydration
 * endpoint's integration tests — auth, ownership (404 for unknown AND
 * foreign sessions, indistinguishably), and the trace-derived citation
 * payloads (a rehydrated transcript obeys the same invariant as the live
 * frame). Same harness as chat.test.ts: in-memory store + stub providers.
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
          reviewerProvider: providers.reviewerProvider,
          embedder: providers.embedder,
          store,
          bridge: runStoreEffect,
        },
        fullStore: store,
        runStore: runStoreEffect,
      };
    },
    buildStoreWiring: () => ({
      fullStore: currentStore,
      runStore: runStoreEffect,
    }),
  };
});

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    throw new Error("chat-session test: neon must not be reached");
  },
}));

const env = { ASSETS: { fetch } };

/** Minted session → Bearer token, plus the store it belongs to. */
async function wiredStore() {
  const store = createMemoryRagStore();
  const session = await runStoreEffect<{ token: string }>(store.createSession());
  currentStore = store;
  return { store, token: session.token };
}

/** Seed one retrievable Ayat Kursi chunk under a titled parent. */
async function seed(store: ReturnType<typeof createMemoryRagStore>): Promise<void> {
  const parentId = await runStoreEffect<string>(
    store.insertDocParent({ sourceKey: "quran/2", title: "Al-Baqarah", metadata: {} }),
  );
  await runStoreEffect<string>(store.insertDocChild({ parentId, ...AYAT_KURSI } as never));
}

/** Ask one question through the real chat route (drives the real pipeline). */
async function ask(token: string, body: Record<string, unknown>): Promise<number> {
  const res = await createApi().request(
    "/v1/chat",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env,
  );
  await res.text();
  return res.status;
}

/** GET the rehydration endpoint raw. */
async function getMessages(token: string | null, sessionId: string): Promise<Response> {
  return createApi().request(
    `/v1/chat/sessions/${sessionId}/messages`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} },
    env,
  );
}

describe("GET /v1/chat/sessions/:id/messages", () => {
  it("requires authentication (401)", async () => {
    await wiredStore();
    const res = await getMessages(null, "sess1");
    expect(res.status).toBe(401);
  });

  it("answers 404 for an unknown session, indistinguishably from a foreign one", async () => {
    const { store, token } = await wiredStore();
    await runStoreEffect<string>(store.createChatSession({ userId: "someone-else" }));
    const unknownRes = await getMessages(token, "sess-unknown");
    expect(unknownRes.status).toBe(404);
    const foreignRes = await getMessages(token, "sess1");
    expect(foreignRes.status).toBe(404);
    expect(await unknownRes.json()).toEqual(await foreignRes.json());
  });

  it("rehydrates the full transcript with trace-derived citations", async () => {
    const { store, token } = await wiredStore();
    await seed(store);
    currentOverrides = { answerText: "Ayat Kursi adalah QS. 2:255." };

    const askStatus = await ask(token, { message: "Apa itu Ayat Kursi?" });
    expect(askStatus).toBe(200);
    const sessionId = (
      store.allChatMessages().at(0) as unknown as { sessionId: string } | undefined
    )?.sessionId;
    expect(sessionId).toBeTruthy();

    const res = await getMessages(token, sessionId!);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      truncated: boolean;
      messages: {
        id: string;
        role: string;
        content: string;
        createdAt: number;
        citations?: {
          messageId: string;
          citations: { label: string; arabic: string; source?: string }[];
          refusal: boolean;
          dhaifWarning: boolean;
        };
      }[];
    };
    expect(body.sessionId).toBe(sessionId);
    expect(body.truncated).toBe(false);
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    const [user, assistant] = body.messages;
    expect(user?.citations).toBeUndefined();
    expect(assistant?.citations?.refusal).toBe(false);
    expect(assistant?.citations?.messageId).toBe(assistant?.id);
    expect(assistant?.citations?.citations).toEqual([
      {
        label: "QS. 2:255",
        arabic: AYAT_KURSI.textAr,
        translation: AYAT_KURSI.textId,
        machineTranslated: true,
        source: "Al-Baqarah",
      },
    ]);
  }, 15000);

  it("a transcript past the cap is marked truncated, never silently clipped (thermo-review A4)", async () => {
    const { store, token } = await wiredStore();
    await seed(store);
    currentOverrides = { answerText: "Ayat Kursi adalah QS. 2:255." };
    expect(await ask(token, { message: "Apa itu Ayat Kursi?" })).toBe(200);
    const sessionId = (store.allChatMessages().at(0) as unknown as { sessionId: string }).sessionId;
    // Push the session past the 200-message rehydration cap.
    for (let i = 0; i < 199; i++) {
      await runStoreEffect<string>(
        store.insertChatMessage({ sessionId, role: "user", content: `extra ${i}` }),
      );
    }

    const res = await getMessages(token, sessionId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      truncated: boolean;
      messages: { content: string }[];
    };
    expect(body.truncated).toBe(true);
    expect(body.messages).toHaveLength(200);
    // The oldest row — the first user question — is the one dropped, and the
    // payload says so instead of presenting the tail as the whole transcript.
    expect(body.messages[0]?.content).not.toBe("Apa itu Ayat Kursi?");
  }, 15000);

  it("a rehydrated refused answer carries refusal: true and no citations", async () => {
    const { store, token } = await wiredStore();
    await seed(store);
    // Fabricated citation → the gate refuses; the refusal is what persists.
    currentOverrides = { answerText: "Menurut QS. 9:99 palsu." };
    expect(await ask(token, { message: "Apa itu Ayat Kursi?" })).toBe(200);
    const sessionId = (store.allChatMessages().at(0) as unknown as { sessionId: string }).sessionId;

    const res = await getMessages(token, sessionId);
    const body = (await res.json()) as {
      messages: {
        role: string;
        content: string;
        citations?: { refusal: boolean; citations: unknown[] };
      }[];
    };
    const assistant = body.messages.at(1);
    expect(assistant?.content).toBe("tidak menemukan dalil yang memadai");
    expect(assistant?.citations?.refusal).toBe(true);
    expect(assistant?.citations?.citations).toEqual([]);
  }, 15000);

  it("a multi-chunk grounded answer rehydrates with both citations in span order", async () => {
    const { store, token } = await wiredStore();
    await seed(store);
    // A second retrievable chunk, so both cited spans pass the gate.
    const parentId = await runStoreEffect<string>(
      store.insertDocParent({ sourceKey: "quran/112", title: "Al-Ikhlas", metadata: {} }),
    );
    await runStoreEffect<string>(
      store.insertDocChild({
        parentId,
        ...AYAT_KURSI,
        citation: { sourceType: "quran", surah: 112, ayah: 1 },
        metadata: { sourceType: "quran", citation: "QS. 112:1" },
        embeddingPrimary: [0, 1, 0],
      } as never),
    );
    currentOverrides = {
      answerText: "QS. 2:255 menyebut keesaan Allah. Juga QS. 112:1.",
    };
    expect(await ask(token, { message: "Apa itu Ayat Kursi?" })).toBe(200);
    const sessionId = (store.allChatMessages().at(0) as unknown as { sessionId: string }).sessionId;

    const res = await getMessages(token, sessionId);
    const body = (await res.json()) as {
      messages: { citations?: { citations: { label: string; source?: string }[] } }[];
    };
    expect(body.messages.at(1)?.citations?.citations.map((c) => c.label)).toEqual([
      "QS. 2:255",
      "QS. 112:1",
    ]);
    expect(body.messages.at(1)?.citations?.citations.map((c) => c.source)).toEqual([
      "Al-Baqarah",
      "Al-Ikhlas",
    ]);
  }, 15000);
});
