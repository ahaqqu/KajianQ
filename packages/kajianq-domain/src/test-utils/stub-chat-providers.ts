import { Effect } from "effect";
import type { CostRecord } from "@app/contracts";
import type { RouterProvider } from "../chat-router";
import type { RetrieverEmbedder } from "../chat-retriever";
import type { GeneratorProvider } from "../chat-generator";

/**
 * Stub chat pipeline providers for integration tests (#8). Built inside the
 * domain so the stubs use the engine's effect runtime — a test importing
 * `effect` from an app resolves a different version, and an Effect value
 * built there is "not a valid effect" for this package's runner.
 *
 * Deterministic: no vendor calls, fixed costs, one canned router JSON, one
 * canned answer that cites whatever the caller sets.
 */

const cost = (modelId: string, microUsd: number): CostRecord => ({
  modelId,
  tokensIn: 1,
  tokensOut: 1,
  latencyMs: 1,
  costMicroUsd: microUsd,
});

export type StubChatProviderOverrides = {
  routerText?: string;
  answerText?: string;
  /** Search hits per similaritySearch call (empty corpus by default). */
  searchHits?: readonly {
    child: { id: string; textAr: string; textId: string | null; metadata: Record<string, unknown> };
    distance: number;
    rankDense: number;
  }[];
};

export function createStubChatProviders(overrides: StubChatProviderOverrides = {}): {
  routerProvider: RouterProvider;
  generatorProvider: GeneratorProvider;
  embedder: RetrieverEmbedder;
} {
  return {
    routerProvider: {
      generate: () =>
        Effect.succeed({
          text:
            overrides.routerText ??
            JSON.stringify({ intent: "factual", subQueries: ["q"], madzhab: "", grade: "", textLayer: "" }),
          cost: cost("stub-router", 1),
        }),
    },
    generatorProvider: {
      generate: () =>
        Effect.succeed({
          text: overrides.answerText ?? "Jawaban berdasar konteks.",
          cost: cost("stub-generator", 2),
        }),
    },
    embedder: {
      embed: () =>
        Effect.succeed({
          vectors: [[1, 0, 0]],
          cost: cost("stub-embedder", 0),
        }),
    },
  };
}

export { cost as stubCost };
