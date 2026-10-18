import { describe, expect, it, vi } from "vite-plus/test";
import { createApi } from "../app";

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock("@sentry/bun", () => ({ captureException }));
import { CHAT_MESSAGE_MAX_LENGTH } from "@app/contracts";
import { parseChatRequest } from "../lib/chat-openapi";
import {
  DEFAULT_REFUSALS,
  dhaifWarning,
  runStoreEffect,
  ulamaDisclaimer,
} from "@app/kajianq-domain";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import { createStubChatProviders } from "@app/kajianq-domain/test-utils/stub-chat-providers";

/** Every pipeline-seam call, in order; the no-spend tests assert this stays empty. */
const spendCalls: string[] = [];

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
 * /v1/chat integration tests against the real route module — in-memory store and
 * the domain's stub providers: no Worker runtime, no vendor calls.
 */

/**
 * One retrievable Quran chunk whose citation label is `QS. 2:255`: a test that
 * wants a *grounded* answer must seed it, because the reviewer refuses any
 * citation the retrieved context does not carry.
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

/** The weak-grade hadith the deterministic grade rule reads. */
const DHAIF_HADITH_CITATION = "HR. Tirmidhi no. 2878 (Dhaif)";

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
    // The mock overrides `buildChatWiring` itself.
    buildChatWiring: () => {
      const store = currentStore;
      const providers = createStubChatProviders(currentOverrides);
      return {
        pipeline: {
          routerProvider: counting("router", providers.routerProvider, spendCalls),
          generatorProvider: counting("generator", providers.generatorProvider, spendCalls),
          // The reviewer is non-optional; the stub passes, so the validator is what is probed.
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

// The database client lives behind the RagStore adapter, so these tests never
// reach one: this mock makes a pool query loud.
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
 * `event:` names are trimmed, a `data:` payload keeps its trailing whitespace, and a
 * frame's multiple `data:` lines join with `\n` — a `trim()` would hide a lost space.
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

/**
 * A message carrying quotes, backslashes, a newline, braces and `</script>` —
 * punctuation-heavy, and every character in it representable, so the contract
 * admits it. The rejected test below probes the same text with a U+0000
 * appended, which is the only difference between an admitted body and a
 * refused one here.
 */
const STORABLE_PUNCTUATION_BODY = '</script>"quote"\\backslash\nnewline {invalid json} null';

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

    // The existing error shape: the ceiling rides the route's `400 invalid_request` path.
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });

    // No spend: the counters sit on the seams, so this is measured, not inferred.
    expect(spendCalls).toEqual([]);

    expect(store.allChatMessages()).toEqual([]);
    expect(store.allTraces().size).toBe(0);
  });

  it("answers 400 invalid_request to a message the store cannot hold, and writes nothing (#478)", async () => {
    const { store, token } = await wiredStore();
    currentStore = store;
    await seed(store);
    currentOverrides = { answerText: "an answer that must never be produced" };
    spendCalls.length = 0;

    // The staging probes, the classes the same defect hides in — a lone
    // surrogate is silently rewritten to U+FFFD by a UTF-8 write, so it is
    // refused here rather than stored as a different message — and the
    // punctuation-heavy body the neighbour test streams with a U+0000 appended.
    for (const message of [
      "\u0000",
      "\u0000riba",
      "riba\u0000",
      "\ud800",
      "riba\ud800",
      "\udc00",
      `${STORABLE_PUNCTUATION_BODY}\u0000`,
    ]) {
      const res = await postRaw(token, { message, language: "id" });

      // The typed answer the route's own contract enumerates — never `internal`.
      expect(res.status, JSON.stringify(message)).toBe(400);
      expect(await res.json(), JSON.stringify(message)).toEqual({ error: "invalid_request" });
    }

    // The refusal is at the boundary: no seam was called, no session, message
    // or trace was written, so nothing of a rejected body survives.
    expect(spendCalls).toEqual([]);
    expect(store.allChatSessions()).toEqual([]);
    expect(store.allChatMessages()).toEqual([]);
    expect(store.allTraces().size).toBe(0);
  });

  it("streams the whole frame set for a punctuation-heavy message, whose U+0000 twin is refused above", async () => {
    const { store, token } = await wiredStore();
    currentStore = store;
    await seed(store);
    currentOverrides = { answerText: "Ayat kursi adalah QS. 2:255." };

    // The same constant the rejected loop probes with a U+0000 appended: quotes,
    // backslashes, a newline, braces and `</script>` are all storable, so this
    // body keeps its place on the answering path and the difference between the
    // two is the NUL alone.
    const { status, frames, answer } = await postChat(token, {
      message: STORABLE_PUNCTUATION_BODY,
      language: "id",
    });

    expect(status).toBe(200);
    expect(frames[0]?.event).toBe("meta");
    for (const event of ["meta", "delta", "citations", "trace", "done"]) {
      expect(
        frames.map((f) => f.event),
        event,
      ).toContain(event);
    }
    expect(frames.at(-1)?.event).toBe("done");
    expect(answer).toContain("QS. 2:255");
  }, 15000);

  it("still admits the control characters the admission calls content-free (#478)", async () => {
    const { store, token } = await wiredStore();
    currentStore = store;
    await seed(store);
    currentOverrides = { answerText: "Ayat kursi adalah QS. 2:255." };
    spendCalls.length = 0;

    // `Cc` without U+0000 is storable, so it is not a rejected body: it reaches
    // the route's content-free gate and is declined there, with the canned copy
    // and no provider call. Nothing could be generated for it either — the
    // fan-out is empty, so nothing is retrieved and no citation has evidence to
    // ground on.
    const { status, frames, answer } = await postChat(token, { message: "\u0001\u0007" });

    expect(status).toBe(200);
    expect(frames.at(-1)?.event).toBe("done");

    // Accepted, not dropped: the question is persisted as the user sent it.
    expect(store.allChatMessages().find((m) => m.role === "user")?.content).toBe("\u0001\u0007");

    const trace = [...store.allTraces().values()].at(0) as
      | { events: { kind: string; detail?: Record<string, unknown> }[] }
      | undefined;
    const intent = trace?.events.find((e) => e.kind === "intent");
    expect(intent?.detail?.["attributes"]).toMatchObject({ fallback: true, contentFree: true });
    // No sub-query was admitted, so none is on the trace: the decline is the
    // deterministic one, not a model route. Nothing reached a provider at all —
    // the gate declines before the router's call, so no seam call is recorded.
    expect(trace?.events.filter((e) => e.kind === "subquery")).toEqual([]);
    expect(spendCalls).toEqual([]);

    const refusal = trace?.events.find((e) => e.kind === "refusal");
    expect(refusal?.detail?.["trigger"]).toBe("content_free_decline");
    const copy = "Mohon maaf, kami tidak menemukan pertanyaan pada pesan Anda.";
    expect(answer).toBe(copy);
    expect(store.allChatMessages().find((m) => m.role === "assistant")?.content).toBe(copy);
  }, 15000);

  it("accepts a message exactly at the ceiling (2,000) and runs the pipeline", async () => {
    const { store, token } = await wiredStore();
    currentStore = store;
    await seed(store);
    currentOverrides = { answerText: "Jawaban berdasar konteks. QS. 2:255" };
    spendCalls.length = 0;

    const { status, frames } = await postChat(token, {
      message: "a".repeat(CHAT_MESSAGE_MAX_LENGTH),
    });

    // The route adds no bound of its own: the contract's ceiling is the boundary.
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

    const trace = store.allTraces().get(meta.messageId) as
      | { id: string; events: { kind: string; cost?: { modelId: string; tokensIn: number } }[] }
      | undefined;
    expect(trace).toBeTruthy();
    expect(trace?.id).toBe(meta.traceId);
    // Traceability: chunks + scores, model identity, tokens, cost.
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

    const assistant = store.allChatMessages().find((m) => m.role === "assistant");
    expect(assistant?.answerTraceId).toBe(meta.traceId);
  }, 15000);

  it("replays the vendor's own delta sequence, with appended rules as a trailing delta", async () => {
    const { store, token } = await wiredStore();
    currentStore = store;
    await seed(store);
    currentOverrides = { streamDeltas: ["Menurut ", "QS. 2:255 ", "Allah Mahahidup."] };

    const { answer, frames } = await postChat(token, { message: "Apa itu Ayat Kursi?" });
    const deltas = frames.filter((f) => f.event === "delta");
    // The vendor's deltas byte-identical first, then the appended rules.
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
    const persisted = store.allTraces().get(meta.messageId) as
      | { events: { kind: string; detail?: { chunks?: { id: string; score?: number }[] } }[] }
      | undefined;
    const persistedRef = persisted?.events
      .find((e) => e.kind === "retrieval")
      ?.detail?.chunks?.at(0);
    expect(traceFrame.technical.chunks[0]?.id).toBe(persistedRef?.id);
    expect(traceFrame.technical.chunks[0]?.score).toBe(persistedRef?.score);
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
    // Prose form: the citation carries no brackets.
    currentOverrides = { answerText: "Rasulullah bersabda dalam HR. Bukhari no. 99999 hal ini." };

    const { answer } = await postChat(token, { message: "Hadits tentang niat?" });
    expect(answer).toBe("tidak menemukan dalil yang memadai");
  }, 15000);

  it("ships a hybrid refusal with its grounded chip on the wire (#436)", async () => {
    // A hybrid draft end to end: the draft quotes the retrieved QS. 2:255 and then runs
    // into the canonical insufficiency sentence, so the reviewer records
    // `generator_refusal`, skips the paid call, and applies the `Always` rules.
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
    // The reader's text still carries the draft: partial answer, its verse and the
    // refusal sentence — the reviewer replaced nothing; only the deterministic rules
    // were APPENDED.
    expect(answer).toContain("Allah Mahahidup");
    expect(answer).toContain("[QS. 2:255]");
    expect(answer).toContain(DEFAULT_REFUSALS.id);
    const trace = store.allTraces().get(meta.messageId) as
      | { events: { kind: string; detail?: Record<string, unknown> }[] }
      | undefined;
    expect(trace?.events.find((e) => e.kind === "refusal")?.detail?.["trigger"]).toBe(
      "generator_refusal",
    );
    // The refusal classification skips the PAID reviewer, never the deterministic
    // "Always" rules, so the hybrid ships decorated like any other delivered answer.
    expect(answer).toContain(ulamaDisclaimer("id"));
    const applied = trace?.events.find((e) => e.kind === "product_rules")?.detail?.["applied"];
    expect(Array.isArray(applied) && applied.includes("ulama_disclaimer")).toBe(true);
  }, 15000);

  it("computes the grade flag for a hybrid refusal: warning line in the text, warning card in the frame (#439)", async () => {
    // A draft that quotes a dhaif-graded hadith and then runs into the canonical
    // refusal sentence: the grade flag is computed from the delivered text.
    const { store, token } = await wiredStore();
    currentStore = store;
    await seed(store, {
      textRaw: "طَلَبُ الْعِلْمِ فَرِيضَةٌ",
      textAr: "طَلَبُ الْعِلْمِ فَرِيضَةٌ",
      textId: "Menuntut ilmu itu kewajiban.",
      citation: { sourceType: "hadith" },
      metadata: {
        sourceType: "hadith",
        citation: DHAIF_HADITH_CITATION,
        grade: "dhaif",
      },
    } as never);
    currentOverrides = {
      answerText:
        `Haditsnya berbunyi demikian [${DHAIF_HADITH_CITATION}], namun sanadnya lemah.\n\n` +
        `Untuk bagian lain dari pertanyaan ini saya ${DEFAULT_REFUSALS.id}.`,
    };

    const { status, answer, frames, meta } = await postChat(token, {
      message: "Sebutkan hadits menuntut ilmu sampai ke negeri China dan sanadnya!",
    });
    expect(status).toBe(200);

    const frame = JSON.parse(frames.find((f) => f.event === "citations")?.data ?? "null") as {
      refusal: boolean;
      dhaifWarning: boolean;
      citations: { label: string }[];
    };
    // The hybrid keeps its chip AND its refusal flag, and the grade flag is computed
    // for the same text; the grade rides the sheet's badge, not the label.
    expect(frame.refusal).toBe(true);
    expect(
      frame.citations
        .map((c) => c.label)
        .some((label) => label.startsWith("HR. Tirmidhi no. 2878")),
    ).toBe(true);
    expect(frame.dhaifWarning).toBe(true);
    // The surfaces agree: the text carries the warning line and the trace names the rule.
    expect(answer).toContain(dhaifWarning("id"));
    expect(answer).toContain(DEFAULT_REFUSALS.id);
    const trace = store.allTraces().get(meta.messageId) as
      | { events: { kind: string; detail?: Record<string, unknown> }[] }
      | undefined;
    const rules = trace?.events.find((e) => e.kind === "product_rules");
    expect(rules?.detail?.["applied"]).toContain("dhaif_warning");
    expect(trace?.events.find((e) => e.kind === "refusal")?.detail?.["trigger"]).toBe(
      "generator_refusal",
    );
    expect(trace?.events.some((e) => e.kind === "review")).toBe(false);
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

    const messages = await runStoreEffect<readonly { role: string; content: string }[]>(
      store.getChatMessages(first.meta.sessionId, { limit: 10 }),
    );
    expect(messages.length).toBe(4);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  }, 15000);

  /**
   * A non-UUID `sessionId` cannot name a session (`chat_sessions.id` is a uuid), so
   * the contract refuses it with the existing 400 — before auth, the store, or any
   * pipeline stage.
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

    // Nothing happens behind the refusal, measured rather than inferred.
    expect(spendCalls).toEqual([]);
    expect(store.allChatMessages()).toEqual([]);
    expect(store.allTraces().size).toBe(0);
    expect(store.allChatSessions()).toEqual([]);
  });

  it("names the offending field in the 400's diagnostic detail (#271)", async () => {
    // The DETAIL makes the refusal diagnosable in ops, naming the field that failed.
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
