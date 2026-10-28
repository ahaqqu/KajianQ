import { runStoreEffect } from "@app/kajianq-domain";
import { describe, expect, it } from "vite-plus/test";
import { createMemoryRagStore } from "./memory-rag-store";

/**
 * The in-memory store's mirror of the admin reads (ADR-0064).
 *
 * The failures this file is looking for are the ones a route test cannot see: a
 * filter the double reads differently from the adapter's SQL (a relaxation probe
 * that adopted nothing is not a relaxation; the text match is case-insensitive on
 * both sides), a question taken from the wrong turn, and a page total that counts
 * only the page it returned.
 */
const ARABIC = "اللَّهُ لَا إِلَٰهُ إِلَّا هُوَ";

type Seed = {
  question?: string | null;
  answer?: string;
  intent?: string;
  refused?: boolean;
  relaxed?: boolean | "probe";
  createdAt?: number;
  modelId?: string;
  costMicroUsd?: number;
  latencyMs?: number;
};

async function seed(
  store: ReturnType<typeof createMemoryRagStore>,
  opts: Seed = {},
): Promise<string> {
  const session = await runStoreEffect<{ userId: string }>(store.createSession());
  const sessionId = await runStoreEffect<string>(
    store.createChatSession({ userId: session.userId }),
  );
  if (opts.question !== null) {
    await runStoreEffect<string>(
      store.insertChatMessage({
        sessionId,
        role: "user",
        content: opts.question ?? "question",
      }),
    );
  }
  const traceId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const cost = {
    modelId: opts.modelId ?? "model-a",
    tokensIn: 3,
    tokensOut: 2,
    latencyMs: opts.latencyMs ?? 50,
    costMicroUsd: opts.costMicroUsd ?? 10,
  };
  const events = [
    { stage: "router", kind: "intent", detail: { intent: opts.intent ?? "ruling" }, at: 1 },
    { stage: "retriever", kind: "llm_call", detail: { purpose: "embed" }, cost, at: 2 },
    ...(opts.refused === true
      ? [
          {
            stage: "generator",
            kind: "refusal",
            reason: "generator refusal",
            detail: { trigger: "generator_refusal" },
            at: 3,
          },
        ]
      : []),
    ...(opts.relaxed !== undefined
      ? [
          {
            stage: "retriever",
            kind: "filter_relaxed",
            detail: {
              dropped: { grade: ["sahih"] },
              track: "primary",
              adopted: opts.relaxed !== "probe",
            },
            at: 4,
          },
        ]
      : []),
  ];
  await runStoreEffect<string>(
    store.insertAnswerTrace({
      messageId,
      userId: session.userId,
      trace: { id: traceId, createdAt: opts.createdAt ?? 1_700_000_000_000, events } as never,
    }),
  );
  await runStoreEffect<string>(
    store.insertChatMessage({
      id: messageId,
      sessionId,
      role: "assistant",
      content: opts.answer ?? "answer",
      answerTraceId: traceId,
    }),
  );
  return traceId;
}

const list = (
  store: ReturnType<typeof createMemoryRagStore>,
  filter = {},
  page = { limit: 20, offset: 0 },
) => runStoreEffect(store.listAdminTraces(filter, page));

describe("memory store: admin trace list", () => {
  it("reads the question from the transcript, not from the trace", async () => {
    const store = createMemoryRagStore();
    await seed(store, { question: "Apa itu ayat kursi?", answer: "QS. 2:255" });
    const page = await list(store);
    expect(page.rows[0]?.question).toBe("Apa itu ayat kursi?");
    expect(page.rows[0]?.answer).toBe("QS. 2:255");
    expect(page.rows[0]?.totals).toEqual({
      tokensIn: 3,
      tokensOut: 2,
      latencyMs: 50,
      costMicroUsd: 10,
      estimated: false,
    });
  });

  it("matches an Arabic question's own text", async () => {
    const store = createMemoryRagStore();
    await seed(store, { question: ARABIC, answer: "answer" });
    // The match is on the stored text as written: an operator pastes the question
    // they are looking at, in the script it was asked in.
    expect((await list(store, { text: ARABIC.slice(0, 12) })).total).toBe(1);
  });

  it("leaves the question empty when the session has no user turn", async () => {
    const store = createMemoryRagStore();
    await seed(store, { question: null });
    expect((await list(store)).rows[0]?.question).toBe("");
  });

  it("matches text case-insensitively on both question and answer", async () => {
    const store = createMemoryRagStore();
    await seed(store, { question: "Apa itu RIBA?", answer: "Riba adalah tambahan." });
    await seed(store, { question: "Apa itu zakat?", answer: "Zakat adalah kewajiban." });
    expect((await list(store, { text: "riba" })).total).toBe(1);
    expect((await list(store, { text: "TAMBAHAN" })).total).toBe(1);
    expect((await list(store, { text: "quran" })).total).toBe(0);
  });

  it("filters on the trace-derived facts", async () => {
    const store = createMemoryRagStore();
    await seed(store, {
      question: "a",
      intent: "ruling",
      refused: true,
      relaxed: true,
      modelId: "m1",
    });
    await seed(store, { question: "b", intent: "factual", refused: false, modelId: "m2" });
    expect((await list(store, { intent: "ruling" })).total).toBe(1);
    expect((await list(store, { refused: true })).total).toBe(1);
    expect((await list(store, { refused: false })).total).toBe(1);
    expect((await list(store, { filterRelaxed: true })).total).toBe(1);
    expect((await list(store, { model: "m2" })).total).toBe(1);
  });

  it("does not read a relaxation probe that adopted nothing as a relaxation", async () => {
    const store = createMemoryRagStore();
    await seed(store, { question: "a", relaxed: "probe" });
    expect((await list(store, { filterRelaxed: true })).total).toBe(0);
    expect((await list(store, { filterRelaxed: false })).total).toBe(1);
  });

  it("filters on the per-message totals the detail shows", async () => {
    const store = createMemoryRagStore();
    await seed(store, { question: "cheap", costMicroUsd: 5, latencyMs: 10 });
    await seed(store, { question: "expensive", costMicroUsd: 900, latencyMs: 2_000 });
    expect((await list(store, { minCostMicroUsd: 100 })).total).toBe(1);
    expect((await list(store, { minLatencyMs: 1_000 })).total).toBe(1);
    expect((await list(store, { minCostMicroUsd: 100 })).rows[0]?.question).toBe("expensive");
  });

  it("filters on the date range inclusively", async () => {
    const store = createMemoryRagStore();
    await seed(store, { question: "old", createdAt: 1_000 });
    await seed(store, { question: "new", createdAt: 5_000 });
    expect((await list(store, { from: 1_000, to: 5_000 })).total).toBe(2);
    expect((await list(store, { from: 2_000 })).total).toBe(1);
    expect((await list(store, { to: 4_999 })).total).toBe(1);
  });

  it("orders newest first and pages with the total of every match", async () => {
    const store = createMemoryRagStore();
    await seed(store, { question: "oldest", createdAt: 1_000 });
    await seed(store, { question: "middle", createdAt: 2_000 });
    await seed(store, { question: "newest", createdAt: 3_000 });
    const firstPage = await list(store, {}, { limit: 2, offset: 0 });
    expect(firstPage.rows.map((row) => row.question)).toEqual(["newest", "middle"]);
    expect(firstPage.total).toBe(3);
    const secondPage = await list(store, {}, { limit: 2, offset: 2 });
    expect(secondPage.rows.map((row) => row.question)).toEqual(["oldest"]);
    expect(secondPage.total).toBe(3);
  });
});

describe("memory store: admin access log", () => {
  it("appends in order and purges nothing inside the retention window", async () => {
    const store = createMemoryRagStore();
    await runStoreEffect(
      store.recordAdminAccess({
        actor: "actor-1",
        route: "traces.list",
        summary: { textSearch: true, page: 1, pageSize: 20 },
      }),
    );
    await runStoreEffect(
      store.recordAdminAccess({
        actor: "actor-1",
        route: "traces.detail",
        summary: { textSearch: false, traceId: "t" },
      }),
    );
    const log = store.allAdminAccess();
    expect(log.map((entry) => entry.route)).toEqual(["traces.list", "traces.detail"]);
    expect(log[0]?.summary).toEqual({ textSearch: true, page: 1, pageSize: 20 });
    // A record inside the window is never reclaimed.
    expect(await runStoreEffect(store.purgeAdminAccessLog())).toBe(0);
    expect(store.allAdminAccess()).toHaveLength(2);
  });
});
