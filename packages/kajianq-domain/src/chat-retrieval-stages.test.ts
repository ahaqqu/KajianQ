import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { type TraceEvent } from "@app/contracts";
import { RunContext, type DecisionSpec, type Decider } from "@app/rag-core";
import { createChatRetriever, type ChatRetrieverDeps } from "./chat-retrieval-stages";
import { RERANK_INSTRUCTIONS } from "./decision-bench-prompts";
import { routedQuery } from "./test-utils/routed-query";

/**
 * The retrieval stage's composition: the pack's rerank wording and the serving
 * decision model are applied only when the role is bound, so an environment
 * without the key keeps today's fused order and makes no call.
 */

const cost = { modelId: "m", tokensIn: 1, tokensOut: 1, latencyMs: 1, costMicroUsd: 1 };

const hit = (id: string) => ({
  child: {
    id,
    textAr: `نص ${id}`,
    textId: `text ${id}`,
    metadata: { sourceType: "quran", citation: `QS. 2:${id}` },
  },
  distance: 0.1,
  rankDense: 1,
});

const store = {
  similaritySearch: () => Effect.succeed([hit("1"), hit("2")]),
  listDocChildNeighboursByChildIds: () => Effect.succeed([]),
};

const deps: Omit<ChatRetrieverDeps, "rerankDecider"> = {
  store: store as never,
  embedder: { embed: () => Effect.succeed({ vectors: [[0.1, 0.2]], cost }) },
  bridge: ((effect: unknown) => Effect.runPromise(effect as never)) as never,
  limit: 2,
};

function rerankDecider(): Decider & { specs: DecisionSpec[] } {
  const specs: DecisionSpec[] = [];
  return {
    modelId: "test-decider",
    specs,
    decide: (spec) => {
      specs.push(spec);
      return Effect.succeed({
        answers: {
          best: {
            type: "choice",
            choice: "c1",
            probabilities: { c0: 0.1, c1: 0.9 },
            confidence: 1,
          },
        },
        cost,
      });
    },
  };
}

async function retrieve(
  retriever: ReturnType<typeof createChatRetriever>,
): Promise<{ chunks: readonly { id: string; rerankScore?: number }[]; events: TraceEvent[] }> {
  const events: TraceEvent[] = [];
  const chunks = await Effect.runPromise(
    Effect.provideService(
      // Opted out of the shared default on purpose: its entry carries the caller's
      // own question, and a route the caller-priority guarantee covers wholly leaves
      // the rerank this suite pins with no candidate to order. This route is the
      // router's paraphrase-only fan-out, which the guarantee does not touch.
      retriever.retrieve(
        routedQuery("apa maksud ayat kursi", {
          subQueries: [{ text: "makna ayat kursi", role: "factual", origin: "model" }],
        }) as never,
      ) as never,
      RunContext,
      { config: {}, now: () => 1, record: (event: TraceEvent) => events.push(event) } as never,
    ) as never,
  );
  if (!Array.isArray(chunks)) throw new Error("retriever returned no chunks");
  return { chunks, events };
}

describe("createChatRetriever — the rerank's composition", () => {
  it("keeps the fused retriever when the decision role is unbound", async () => {
    const { chunks, events } = await retrieve(
      createChatRetriever({ ...deps, rerankDecider: null }),
    );
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.rerankScore === undefined)).toBe(true);
    expect(events.some((event) => event.kind === "rerank")).toBe(false);
  });

  it("wraps it with the pack's Choice instruction and the injected decider", async () => {
    const decider = rerankDecider();
    const { chunks, events } = await retrieve(
      createChatRetriever({ ...deps, rerankDecider: decider }),
    );

    expect(chunks.map((chunk) => chunk.id)).toEqual(["2", "1"]);
    expect(chunks.map((chunk) => chunk.rerankScore)).toEqual([0.9, 0.1]);
    expect(decider.specs[0]?.questions["best"]).toMatchObject({
      type: "choice",
      instructions: RERANK_INSTRUCTIONS,
    });
    expect(events.some((event) => event.kind === "rerank")).toBe(true);
  });
});
