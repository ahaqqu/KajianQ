import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { totalCostMicroUsd, type CostRecord } from "@app/contracts";
import type { Decliner } from "@app/rag-core";
import { runChatPipeline } from "./chat-pipeline";
import { CONTENT_FREE_DECLINE_TEXT } from "./chat-content-free-decline";
import { DEFAULT_REFUSALS } from "./chat-refusal";
import type { RouterProvider } from "./chat-router";
import type { GeneratorProvider } from "./chat-generator";
import type { ReviewerProvider } from "./chat-reviewer";
import type { RetrieverEmbedder } from "./chat-retriever";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";
import type { KajianQFilters } from "./filters";

/**
 * INTEGRATION TEST — the route gate and the answer it earns (`SPECS.md` §3.3
 * stages 1 and 6).
 *
 * The invariant: a caller's text carrying no letter and no digit is not a
 * question, so the router stage asks the model nothing, admits no sub-query for
 * it, and retrieval has nothing to embed and nothing to search — **and the run
 * answers it from the product's own canned copy, without entering the generator
 * or the reviewer**, so the path buys nothing at all. Its trace records the
 * deterministic route (`fallback` beside `contentFree`) instead of a
 * classification invented for a non-question, and the decline instead of a
 * generation.
 *
 * Asserted through the real composition — `runChatPipeline`, the same
 * `buildChatStages` wiring the chat route runs (ADR-0021) — with a spy on every
 * seam that can spend or read, because the spend is what the defect is about:
 * asserting the router's return value alone would not catch an embed, a search
 * or a generation running over an emptied fan-out. The mixed cases are the
 * boundary in the other direction: a question carrying content keeps its full
 * fan-out, its retrieval, and its paid answer path — a refusal it earns is the
 * generated one.
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
function harness(options: { generatorText?: string; decliner?: Decliner<KajianQFilters> } = {}) {
  const store = createMemoryRagStore();
  const routerCalls: string[] = [];
  const embedded: (readonly string[])[] = [];
  const searches: string[] = [];
  const generatorCalls: unknown[] = [];
  const reviewerCalls: unknown[] = [];

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
    generate: (spec) => {
      generatorCalls.push(spec);
      return Effect.succeed({
        text: options.generatorText ?? "Jawaban berdasar konteks.",
        cost: cost("stub-generator"),
      });
    },
  };
  const reviewerProvider: ReviewerProvider = {
    generate: (spec) => {
      reviewerCalls.push(spec);
      return Effect.succeed({
        text: JSON.stringify({ verdict: "pass", reason: "stub" }),
        cost: cost("stub-reviewer"),
      });
    },
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
    generatorCalls,
    reviewerCalls,
    seed: async () => {
      await seedChunk(store);
    },
    run: async (
      text: string,
      options2: { filters?: KajianQFilters; language?: "id" | "en" } = {},
    ) =>
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
            language: options2.language ?? "id",
            ...(options.decliner !== undefined ? { decliner: options.decliner } : {}),
          } as never,
          { text, ...(options2.filters !== undefined ? { filters: options2.filters } : {}) },
        ) as never,
      ),
  };
}

type Answer = {
  text: string;
  trace: {
    events: { kind: string; stage?: string; detail?: Record<string, unknown> }[];
  };
};

function eventsOf(
  answer: unknown,
): { kind: string; stage?: string; detail?: Record<string, unknown> }[] {
  return (answer as Answer).trace.events;
}

/** Every `llm_call` the run recorded, by the label its stage gave it. */
function llmCallPurposes(answer: unknown): unknown[] {
  return eventsOf(answer)
    .filter((event) => event.kind === "llm_call")
    .map((event) => event.detail?.["purpose"]);
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
    // The whole path is free: no provider call of any kind, so no `llm_call`
    // event and nothing for the trace to price.
    expect(llmCallPurposes(answer)).toEqual([]);
    expect(totalCostMicroUsd((answer as Answer).trace as never)).toBe(0);
    expect(h.generatorCalls).toEqual([]);
    expect(h.reviewerCalls).toEqual([]);
    // The answer is the product's canned decline, not a generated one.
    expect((answer as Answer).text).toBe(CONTENT_FREE_DECLINE_TEXT.id);
    // ... and it is a first-class answer: recorded on the trace, with the route
    // it was declined for still marked.
    expect(eventsOf(answer).find((event) => event.kind === "refusal")).toMatchObject({
      stage: "generator",
      detail: { trigger: "content_free_decline" },
    });
  });

  it("declines in the question's language, from the persisted record", async () => {
    for (const language of ["id", "en"] as const) {
      const h = harness();
      const answer = await h.run("\u200b\u200d\u200b", { language });
      expect((answer as Answer).text).toBe(CONTENT_FREE_DECLINE_TEXT[language]);
      expect(h.generatorCalls).toEqual([]);
      expect(llmCallPurposes(answer)).toEqual([]);
    }
  });

  it("answers from a decliner the composition root injects, not its own", async () => {
    // The decline is a wiring choice: an injected decliner takes the content-free
    // route, so a caller whose copy differs does not have to edit this composition
    // root. What the domain's own decliner answers is the case above.
    const h = harness({
      decliner: {
        decline: () =>
          Effect.succeed({
            text: "no question in that message",
            reason: "the injected decliner took the route",
            trigger: "injected_decline",
          }),
      },
    });

    const answer = await h.run("\u200b");

    expect((answer as Answer).text).toBe("no question in that message");
    expect(h.generatorCalls).toEqual([]);
    expect(eventsOf(answer).find((event) => event.kind === "refusal")).toMatchObject({
      stage: "generator",
      detail: { trigger: "injected_decline" },
    });
  });

  it("still pays for a content-bearing question the evidence cannot ground", async () => {
    // The other direction of the same seam: the decline must not swallow the
    // ordinary path. A question carrying content reaches the generator, and a
    // draft that declines is the GENERATED refusal — its trigger and its cost
    // record are unchanged.
    const h = harness({ generatorText: DEFAULT_REFUSALS.id });
    await h.seed();

    const answer = await h.run("Apa hukum riba dalam muamalah?");

    expect(h.generatorCalls).toHaveLength(1);
    expect(h.reviewerCalls).toEqual([]);
    expect(llmCallPurposes(answer)).toContain("generate");
    expect(totalCostMicroUsd((answer as Answer).trace as never)).toBeGreaterThan(0);
    expect(eventsOf(answer).find((event) => event.kind === "refusal")).toMatchObject({
      detail: { trigger: "generator_refusal" },
    });
    expect((answer as Answer).text).toContain(DEFAULT_REFUSALS.id);
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
    const answer = await h.run("\u200b", { filters: { madzhab: ["hambali"] } });

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
