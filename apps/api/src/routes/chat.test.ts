import { describe, expect, it, vi } from "vitest";
import { createApi } from "../app";

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock("@sentry/bun", () => ({ captureException }));
import { CHAT_MESSAGE_MAX_LENGTH } from "@app/contracts";
import { parseChatRequest } from "../lib/chat-openapi";
import { DEFAULT_REFUSALS, runStoreEffect } from "@app/kajianq-domain";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import { createStubChatProviders } from "@app/kajianq-domain/test-utils/stub-chat-providers";

/**
 * Every call into a pipeline seam, in order (#256). The no-spend test reads
 * this: "the router, generator and reviewer did not run" is measured on the
 * seams the pipeline actually calls, not inferred from a 400 status.
 */
const spendCalls: string[] = [];

/**
 * Wrap one seam so each method call is recorded. The pipeline calls these
 * objects' methods and nothing else, so an empty `spendCalls` after a request
 * is the assertion that no stage executed.
 */
function counting<T extends object>(name: string, seam: T, calls: string[]): T {
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(seam)) {
    wrapped[key] =
      typeof value === "function"
        ? (...args: unknown[]) => {
            calls.push(`${name}.${key}`);
            return (value as (...inner: unknown[]) => unknown)(...args);
          }
        : value;
  }
  return wrapped as T;
}

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
    // B1: the route resolves its wiring through the shared `wiringOr503` seam
    // over `buildChatWiring`; the mock overrides `buildChatWiring` itself
    // (`wiringOr503` stays actual — its own posture is covered in
    // chat-wiring.test.ts), so these tests exercise the route, not config.
    buildChatWiring: () => {
      const store = currentStore;
      const providers = createStubChatProviders(currentOverrides);
      return {
        pipeline: {
          routerProvider: counting("router", providers.routerProvider, spendCalls),
          generatorProvider: counting("generator", providers.generatorProvider, spendCalls),
          // The reviewer is non-optional on the chat path (#10); the stub
          // passes, so the deterministic validator is what these tests probe.
          reviewerProvider: counting("reviewer", providers.reviewerProvider, spendCalls),
          reviewerDecider: providers.reviewerDecider,
          embedder: counting("embedder", providers.embedder, spendCalls),
          store,
          bridge: runStoreEffect,
        },
        fullStore: store,
        runStore: runStoreEffect,
      };
    },
  };
});

// The database client lives behind the RagStore adapter (ADR-0008), so
// these route tests never reach one: constructing or querying the pool is
// the failure this mock makes loud.
vi.mock("pg", () => ({
  Pool: class {
    on(): void {}
    query(): never {
      throw new Error("chat test: the database must not be reached");
    }
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
  const meta = JSON.parse(frames.find((f) => f.event === "meta")?.data ?? "{}") as {
    sessionId: string;
    messageId: string;
    traceId: string;
  };
  return { status: res.status, frames, answer, meta };
}

/** POST /v1/chat and return the raw response (the 4xx rows read its body). */
async function postRaw(token: string, body: Record<string, unknown>): Promise<Response> {
  return createApi().request(
    "/v1/chat",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env,
  );
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

  it("rejects an over-length message with the existing 400 and spends nothing (#256)", async () => {
    const { store, token } = await wiredStore();
    currentStore = store;
    await seed(store);
    currentOverrides = { answerText: "an answer that must never be produced" };
    spendCalls.length = 0;

    const res = await createApi().request(
      "/v1/chat",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: "a".repeat(CHAT_MESSAGE_MAX_LENGTH + 1) }),
      },
      env,
    );

    // The EXISTING error shape, not a new one: the route already surfaces a
    // valibot failure as `400 invalid_request` (chat-openapi.ts), and the
    // ceiling rides that path.
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });

    // The point of the ticket — no spend. The counters sit on the seams the
    // pipeline actually calls (router, generator, reviewer, embedder), so
    // this is measured, not inferred from the status code.
    expect(spendCalls).toEqual([]);

    // And the question never reached the store: no persisted user message and
    // no answer trace for a request that was refused before the pipeline.
    expect(store.allChatMessages()).toEqual([]);
    expect(store.allTraces().size).toBe(0);
  });

  it("accepts a message exactly at the ceiling (2,000) and runs the pipeline", async () => {
    const { store, token } = await wiredStore();
    currentStore = store;
    await seed(store);
    currentOverrides = { answerText: "Jawaban berdasar konteks. QS. 2:255" };
    spendCalls.length = 0;

    const { status, frames } = await postChat(token, {
      message: "a".repeat(CHAT_MESSAGE_MAX_LENGTH),
    });

    // The route adds no bound of its own: the contract's ceiling is the
    // boundary, and one character under it is a legitimate question.
    expect(status).toBe(200);
    expect(frames.at(-1)?.event).toBe("done");
    expect(spendCalls).toContain("router.generate");
  }, 15000);

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

  it("emits the user-facing trace frame after citations, derived from the persisted trace (#12)", async () => {
    const { store, token } = await wiredStore();
    currentStore = store;
    await seed(store);
    currentOverrides = { answerText: "Jawaban berdasar konteks. QS. 2:255" };

    const { status, frames, meta } = await postChat(token, { message: "Apa itu Ayat Kursi?" });
    expect(status).toBe(200);

    // Wire order: meta → deltas → citations → trace → done.
    const events = frames.map((f) => f.event);
    expect(events.indexOf("trace")).toBeGreaterThan(events.indexOf("citations"));
    expect(events.at(-1)).toBe("done");

    const traceFrame = JSON.parse(frames.find((f) => f.event === "trace")?.data ?? "null") as {
      messageId: string;
      sources: { id: string; source?: string }[];
      technical: { chunks: { id: string; score?: number }[]; models: string[] };
    };
    expect(traceFrame.messageId).toBe(meta.messageId);
    // The panel's provenance matches the persisted trace's own refs.
    const persisted = store.allTraces().get(meta.messageId) as
      | { events: { kind: string; detail?: { chunks?: { id: string; score?: number }[] } }[] }
      | undefined;
    const persistedRef = persisted?.events
      .find((e) => e.kind === "retrieval")
      ?.detail?.chunks?.at(0);
    expect(traceFrame.technical.chunks[0]?.id).toBe(persistedRef?.id);
    expect(traceFrame.technical.chunks[0]?.score).toBe(persistedRef?.score);
    // Display title joined server-side; model identities carried verbatim.
    expect(traceFrame.sources[0]?.source).toBe("Al-Baqarah");
    expect(traceFrame.technical.models.length).toBeGreaterThan(0);
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

  it("ships a hybrid refusal with its grounded chip on the wire (#436)", async () => {
    // The shape #436 is about, end to end through the route: the store holds
    // QS. 2:255, the draft quotes it and then runs into the canonical
    // insufficiency sentence, so the reviewer records `generator_refusal` and
    // returns the draft unchanged. The emitted frame must carry the chip the
    // text earns BESIDE `refusal: true` — the user reads a cited answer whose
    // last line is the refusal, not the empty pure-refusal sheet.
    const { store, token } = await wiredStore();
    currentStore = store;
    await seed(store);
    currentOverrides = {
      answerText:
        "Allah Mahahidup sebagaimana firman-Nya dalam [QS. 2:255].\n\n" +
        `Untuk bagian lain dari pertanyaan ini saya ${DEFAULT_REFUSALS.id}.`,
    };

    const { status, answer, frames, meta } = await postChat(token, {
      message: "Apa itu Ayat Kursi, dan kapan Kiamat?",
    });
    expect(status).toBe(200);

    const frame = JSON.parse(frames.find((f) => f.event === "citations")?.data ?? "null") as {
      refusal: boolean;
      dhaifWarning: boolean;
      citations: { label: string; arabic: string }[];
    };
    expect(frame.refusal).toBe(true);
    expect(frame.citations.map((c) => c.label)).toEqual(["QS. 2:255"]);
    // The chip is resolved, not a label without display data.
    expect(frame.citations[0]?.arabic).toBe(AYAT_KURSI.textAr);
    expect(frame.dhaifWarning).toBe(false);
    // The reader's text is the draft itself: partial answer, its verse, and the
    // refusal sentence — the reviewer replaced nothing (that is what makes this
    // a hybrid, and why the route chunks the settled text).
    expect(answer).toContain("Allah Mahahidup");
    expect(answer).toContain("[QS. 2:255]");
    expect(answer).toContain(DEFAULT_REFUSALS.id);
    // The decision is on the persisted trace, as the generator's own trigger.
    const trace = store.allTraces().get(meta.messageId) as
      | { events: { kind: string; detail?: { trigger?: string } }[] }
      | undefined;
    expect(trace?.events.find((e) => e.kind === "refusal")?.detail?.trigger).toBe(
      "generator_refusal",
    );
    // The product rules were skipped with that classification (SPECS §2.2's
    // "Grade flag — Always" debt is #439): no disclaimer rides a hybrid, which
    // is exactly why the frame cannot claim a warning the pipeline never wrote.
    expect(answer).not.toContain("bukan fatwa");
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

  /**
   * #271: the store's `chat_sessions.id` is a `uuid`, so a non-UUID
   * `sessionId` used to pass validation and die in the adapter's `::uuid`
   * cast — a 500 `{"error":"internal"}` with no server fault behind it,
   * reproduced on staging with the body below (`sessionId: "en"`). The
   * contract is the boundary: the refusal is the route's existing 400, before
   * auth, the store, or any pipeline stage.
   */
  it("rejects a non-UUID sessionId with the documented 400 and creates nothing (#271)", async () => {
    const { store, token } = await wiredStore();
    currentStore = store;
    await seed(store);
    currentOverrides = { answerText: "an answer that must never be produced" };
    spendCalls.length = 0;

    const res = await postRaw(token, { message: "Apa maksud Ayat Kursi?", sessionId: "en" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });

    // Nothing happened behind the refusal, measured rather than inferred:
    // no stage on the pipeline seams, no persisted question, no trace, and no
    // chat session row (a refused request must not leave one behind).
    expect(spendCalls).toEqual([]);
    expect(store.allChatMessages()).toEqual([]);
    expect(store.allTraces().size).toBe(0);
    expect(store.allChatSessions()).toEqual([]);
  });

  it("names the offending field in the 400's diagnostic detail (#271)", async () => {
    // The body the client sees is the route's one error shape; the DETAIL is
    // what makes the refusal diagnosable in ops — and it names the field, so
    // a malformed sessionId is not confused with a malformed question.
    const warnings: string[] = [];
    const parsed = await parseChatRequest(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        body: JSON.stringify({ message: "hi", sessionId: "en" }),
      }),
      { warn: (msg, fields) => warnings.push(`${msg} ${JSON.stringify(fields ?? {})}`) },
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error).toBe("invalid_request");
    expect(parsed.detail).toContain("sessionId");
    expect(warnings.join(" ")).toContain("sessionId");
  });

  it("answers 404 for a well-formed but unknown session UUID, like a foreign one", async () => {
    const { store, token } = await wiredStore();
    currentStore = store;
    currentOverrides = { answerText: "ok" };
    // The format check must not become an existence oracle: a UUID that names
    // nothing and a UUID owned by someone else answer identically.
    const unknown = await postRaw(token, { message: "hi", sessionId: crypto.randomUUID() });
    const foreignSessionId = await runStoreEffect<string>(
      store.createChatSession({ userId: "someone-else" }),
    );
    const foreign = await postRaw(token, { message: "hi", sessionId: foreignSessionId });

    expect(unknown.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(await unknown.json()).toEqual(await foreign.json());
  });
});
