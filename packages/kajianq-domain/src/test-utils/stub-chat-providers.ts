import { Effect, Stream } from "effect";
import type { CostRecord } from "@app/contracts";
import type { RouterProvider } from "../chat-router";
import type { RetrieverEmbedder } from "../chat-retriever";
import type { GeneratorProvider } from "../chat-generator";

/**
 * Stub chat pipeline providers for integration tests (#8, extended #10).
 * Built inside the domain so the stubs use the engine's effect runtime — a
 * test importing `effect` from an app resolves a different version, and an
 * Effect value built there is "not a valid effect" for this package's runner.
 *
 * Deterministic: no vendor calls, fixed costs, one canned router JSON, one
 * canned answer that cites whatever the caller sets. The generator streams by
 * default (the chat path's real shape); `streamDeltas` overrides the delta
 * sequence so a test can prove the route re-emits vendor deltas, and setting
 * `answerText` alone streams that text as a single delta.
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
  /** Explicit delta sequence (overrides `answerText` chunking). */
  streamDeltas?: readonly string[];
  /** Omit `stream` so the generator's non-streaming fallback is exercised. */
  noStream?: boolean;
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
  const answerText = overrides.answerText ?? "Jawaban berdasar konteks.";
  const deltas = overrides.streamDeltas ?? [answerText];
  const generatorProvider: GeneratorProvider = {
    generate: () =>
      Effect.succeed({
        text: answerText,
        cost: cost("stub-generator", 2),
      }),
    ...(overrides.noStream === true
      ? {}
      : {
          stream: () =>
            Effect.succeed({
              deltas: Stream.fromIterable(deltas),
              cost: () => Effect.succeed(cost("stub-generator", 2)),
            }),
        }),
  };
  return {
    routerProvider: {
      generate: () =>
        Effect.succeed({
          text:
            overrides.routerText ??
            JSON.stringify({
              intent: "factual",
              subQueries: ["q"],
              madzhab: "",
              grade: "",
              textLayer: "",
            }),
          cost: cost("stub-router", 1),
        }),
    },
    generatorProvider,
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
