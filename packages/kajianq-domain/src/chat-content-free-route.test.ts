import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { CostRecord } from "@app/contracts";
import { runChatPipeline } from "./chat-pipeline";
import type { RouterProvider } from "./chat-router";
import type { GeneratorProvider } from "./chat-generator";
import type { ReviewerProvider } from "./chat-reviewer";
import type { RetrieverEmbedder } from "./chat-retriever";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";
import type { KajianQFilters } from "./filters";

/**
 * INTEGRATION TEST — the route gate: a question that is not a query is not
 * routed (`SPECS.md` §3.3 stage 1).
 *
 * The invariant: a caller's text carrying no letter and no digit is not a
 * question, so the router stage asks the model nothing, admits no sub-query for
 * it, and retrieval has nothing to embed and nothing to search. The run still
 * answers — the gate is on the route, not on the answer path — and its trace
 * records the deterministic route (`fallback` beside `contentFree`) instead of a
 * classification invented for a non-question.
 *
 * Asserted through the real composition — `runChatPipeline`, the same
 * `buildChatStages` wiring the chat route runs (ADR-0021) — with a spy on every
 * seam that can spend or read, because the spend is what the defect is about:
 * asserting the router's return value alone would not catch an embed or a search
 * running over an emptied fan-out. The mixed case is the boundary in the other
 * direction: a question carrying content keeps its full fan-out and retrieval.
 */

const cost = (modelId: string): CostRecord => ({
  modelId,
  tokensIn: 1,
  tokensOut: 1,
  latencyMs: 1,
  costMicroUsd: 1,
});

/** The router stub's reply for a question that carries content. */
const ROUTER_REPLY = JSON.stringify({
  intent: "ruling",
  category: "fikih",
  needsPrinciple: false,
  // The model's own phrasings, unlabelled, so the repair below has to add the
  // rules the question fired (`factual`, and `dalil` for a fikih category).
  subQueries: [{ text: "hukum riba dalam muamalah" }, { text: "dalil Al-Quran tentang riba" }],
});

/** A hadith chunk the stub query vector reaches on both tracks. */
async function seedChunk(store: ReturnType<typeof createMemoryRagStore>): Promise<void> {
  const parentId = await Effect.runPromise(
    store.insertDocParent({
      sourceKey: "hadith/malik/1",
      title: "HR. Malik no. 1",
      metadata: { sourceType: "hadith" },
    }),
  );
  await Effect.runPromise(
    store.insertDocChildren([
      {
        parentId,
        textRaw: "hadith-ar",
        textAr: "hadith-ar",
        textId: "hadith-id",
        citation: { sourceType: "hadith", collection: "Malik", number: 1 },
        embeddingPrimary: [1, 0],
        embeddingFallback: [1, 0],
        ordinal: 0,
        metadata: { sourceType: "hadith", citation: "HR. Malik no. 1", grade: "sahih" },
      },
    ]),
  );
}

/** The pipeline deps with a spy on every seam that can spend or read. */
function harness() {
  const store = createMemoryRagStore();
  const routerCalls: string[] = [];
  const embedded: (readonly string[])[] = [];
  const searches: string[] = [];

  const routerProvider: RouterProvider = {
    generate: (spec) => {
      routerCalls.push(spec.turns.at(-1)?.content ?? "");
      return Effect.succeed({ text: ROUTER_REPLY, cost: cost("stub-router") });
    },
  };
  const embedder: RetrieverEmbedder = {
    embed: (spec) => {
      embedded.push(spec.texts);
      // One vector per text: the retriever pairs them by index, so a short answer
      // would silently search fewer sub-queries than it embedded.
      return Effect.succeed({ vectors: spec.texts.map(() => [1, 0]), cost: cost("stub-embedder") });
    },
  };
  const generatorProvider: GeneratorProvider = {
    generate: () =>
      Effect.succeed({ text: "Jawaban berdasar konteks.", cost: cost("stub-generator") }),
  };
  const reviewerProvider: ReviewerProvider = {
    generate: () =>
      Effect.succeed({
        text: JSON.stringify({ verdict: "pass", reason: "stub" }),
        cost: cost("stub-reviewer"),
      }),
  };

  // The store with a spy on the one read retrieval makes per (sub-query, track):
  // the assertion that carries "nothing was searched".
  const spyStore: ReturnType<typeof createMemoryRagStore> = {
    ...store,
    similaritySearch: (track, embedding, opts) => {
      searches.push(track);
      return store.similaritySearch(track, embedding, opts);
    },
  };

  return {
    routerCalls,
    embedded,
    searches,
    seed: async () => {
      await seedChunk(store);
    },
    run: async (text: string, filters?: KajianQFilters) =>
      Effect.runPromise(
        runChatPipeline(
          {
            routerProvider,
            generatorProvider,
            reviewerProvider,
            reviewerDecider: null,
            embedder,
            store: spyStore as never,
            bridge: (effect: never) => Effect.runPromise(effect),
            language: "id",
          } as never,
          { text, ...(filters !== undefined ? { filters } : {}) },
        ) as never,
      ),
  };
}

type Answer = {
  text: string;
  trace: { events: { kind: string; detail?: Record<string, unknown> }[] };
};

function eventsOf(answer: unknown): { kind: string; detail?: Record<string, unknown> }[] {
  return (answer as Answer).trace.events;
}

function subQueriesOf(answer: unknown): { text: string; role?: string; origin?: string }[] {
  return eventsOf(answer)
    .filter((event) => event.kind === "subquery")
    .map((event) => event.detail as { text: string; role?: string; origin?: string });
}

describe("a content-free question is not routed", () => {
  it("spends no router call, no embed and no search, and still answers", async () => {
    const h = harness();
    await h.seed();

    const answer = await h.run("\u200b\u200d\u200b");

    // Nothing was asked: the router's input is a question, and this is not one.
    expect(h.routerCalls).toEqual([]);
    // No sub-query was admitted, so nothing was embedded and nothing was searched.
    expect(subQueriesOf(answer)).toEqual([]);
    expect(h.embedded).toEqual([]);
    expect(h.searches).toEqual([]);
    // The run still answers, and its trace says which route it took.
    expect((answer as Answer).text).toBeTruthy();
    const intent = eventsOf(answer).find((event) => event.kind === "intent");
    expect(intent?.detail).toMatchObject({
      intent: "factual",
      attributes: { fallback: true, contentFree: true },
    });
    // The `retrieval` event is a record of the stage, not a claim that a search
    // ran: it exists on every route, and on this one it carries nothing.
    const retrieval = eventsOf(answer).find((event) => event.kind === "retrieval");
    expect(retrieval?.detail).toEqual({ chunks: [] });
    // The router's own call is the one that is missing: the generator's and the
    // reviewer's are both paid for, because the run still answers.
    const purposes = eventsOf(answer)
      .filter((event) => event.kind === "llm_call")
      .map((event) => event.detail?.["purpose"]);
    expect(purposes).not.toContain("intent");
    expect(purposes).toContain("generate");
  });

  it("declines every content-free shape, not just the zero-width one", async () => {
    // The classes the admission names: `Cc` controls, an emoji, whitespace, the
    // punctuation of another script, and the `Cf` characters that are not
    // ECMAScript whitespace. A bare numeral is deliberately NOT here — a digit is
    // content, so `decomposeQuery` and the gate both keep it.
    for (const text of [
      "\u0001\u0007",
      "😀🔥",
      "   ",
      "؟!؟",
      "\ufeff",
      "\u00ad",
      "\u200b".repeat(1500),
    ]) {
      const h = harness();
      const answer = await h.run(text);
      expect(h.routerCalls, `routed ${JSON.stringify(text)}`).toEqual([]);
      expect(subQueriesOf(answer), `fanned out over ${JSON.stringify(text)}`).toEqual([]);
      expect(h.embedded, `embedded ${JSON.stringify(text)}`).toEqual([]);
      expect(h.searches, `searched ${JSON.stringify(text)}`).toEqual([]);
    }
  });

  it("carries the caller's explicit filters on the declined route", async () => {
    // The route selects no source and runs no search; the filters it would have
    // run with are what the trace publishes, so the panel cannot disagree with the
    // route's own decision.
    const h = harness();
    const answer = await h.run("\u200b", { madzhab: ["hambali"] });

    const intent = eventsOf(answer).find((event) => event.kind === "intent");
    expect(intent?.detail).toMatchObject({
      attributes: { fallback: true, contentFree: true, madzhab: ["hambali"] },
    });
    expect(eventsOf(answer).find((event) => event.kind === "source_routing")).toMatchObject({
      detail: { sources: [], filters: { madzhab: ["hambali"] } },
    });
    expect(h.routerCalls).toEqual([]);
  });

  it("still fans out over 2–4 sub-queries and still retrieves for a real question", async () => {
    const h = harness();
    await h.seed();

    const answer = await h.run("Apa hukum riba dalam muamalah?");

    expect(h.routerCalls).toHaveLength(1);
    const subQueries = subQueriesOf(answer);
    expect(subQueries.length).toBeGreaterThanOrEqual(2);
    expect(subQueries.length).toBeLessThanOrEqual(4);
    // The model's own phrasings survive the repair, beside the factual rule's
    // verbatim question.
    expect(subQueries.some((sub) => sub.origin === "model")).toBe(true);
    expect(subQueries.some((sub) => sub.origin === "rule")).toBe(true);
    // One embed for the whole fan-out, and a pair of track searches per sub-query.
    expect(h.embedded).toEqual([subQueries.map((sub) => sub.text)]);
    expect(h.searches).toEqual(subQueries.flatMap(() => ["primary", "fallback"]));
    const retrieval = eventsOf(answer).find((event) => event.kind === "retrieval");
    const chunks = (retrieval?.detail?.["chunks"] ?? []) as unknown[];
    expect(chunks.length).toBeGreaterThan(0);
  });
});
