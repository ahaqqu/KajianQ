import { Effect, Stream } from "effect";
import type { RouterProvider } from "../chat-router";
import type { RetrieverEmbedder } from "../chat-retriever";
import type { GeneratorProvider } from "../chat-generator";
import type { ReviewerProvider } from "../chat-reviewer";

/**
 * Stub chat pipeline providers for integration tests.
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

/**
 * The stub CostRecord: fixed tokens/latency, caller-chosen micro-USD. Typed by
 * inference so this file needs no `@app/contracts` import (the agentic import
 * cap counts every import, and the structural check happens where the stub is
 * returned as a `GeneratorProvider`/`RouterProvider`).
 */
function cost(modelId: string, microUsd: number) {
  return { modelId, tokensIn: 1, tokensOut: 1, latencyMs: 1, costMicroUsd: microUsd };
}

export type StubChatProviderOverrides = {
  routerText?: string;
  answerText?: string;
  /** Explicit delta sequence (overrides `answerText` chunking). */
  streamDeltas?: readonly string[];
  /** The reviewer stub's verdict (default `pass`). */
  reviewerVerdict?: "pass" | "fail";
  /** Omit `stream` so the generator's non-streaming fallback is exercised. */
  noStream?: boolean;
  /** The generator's call fails, so a run can fail after retrieval has spent. */
  generatorFails?: boolean;
  /** The embedder's CostRecord fields to override (default: one token each way,
   * 1 ms, 0 µUSD). A non-zero `costMicroUsd` makes the embed's place in an
   * answer's recorded spend visible. */
  embedCost?: Partial<{
    modelId: string;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number;
    costMicroUsd: number;
    estimated: boolean;
  }>;
  /** Wire the reviewer's decision-model pre-gate with this call's micro-USD.
   * Absent = no decider, the unkeyed-decision-vendor environment. */
  pregateMicroUsd?: number;
};

export function createStubChatProviders(overrides: StubChatProviderOverrides = {}): {
  routerProvider: RouterProvider;
  generatorProvider: GeneratorProvider;
  reviewerProvider: ReviewerProvider;
  embedder: RetrieverEmbedder;
  /**
   * The reviewer pre-gate is unwired by default: the stub models an
   * environment where the decision vendor's key is absent, so pipeline tests
   * that do not opt in exercise the reviewer path without it.
   */
  reviewerDecider: import("@app/rag-core").Decider | null;
} {
  const answerText = overrides.answerText ?? "Jawaban berdasar konteks.";
  const deltas = overrides.streamDeltas ?? [answerText];
  const generatorFails = overrides.generatorFails === true;
  const generatorProvider: GeneratorProvider = {
    generate: () =>
      generatorFails
        ? Effect.fail(new Error("stub generator failure"))
        : Effect.succeed({
            text: answerText,
            cost: cost("stub-generator", 2),
          }),
    ...(overrides.noStream === true
      ? {}
      : {
          stream: () =>
            generatorFails
              ? Effect.fail(new Error("stub generator failure"))
              : Effect.succeed({
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
    // The cross-vendor reviewer stub: passes by default, so tests exercise the
    // deterministic validator (the gate that must hold without any LLM).
    reviewerProvider: {
      generate: () =>
        Effect.succeed({
          text: JSON.stringify({ verdict: overrides.reviewerVerdict ?? "pass", reason: "stub" }),
          cost: cost("stub-reviewer", 1),
        }),
    },
    embedder: {
      embed: () =>
        Effect.succeed({
          vectors: [[1, 0, 0]],
          cost: { ...cost("stub-embedder", 0), ...overrides.embedCost },
        }),
    },
    reviewerDecider:
      overrides.pregateMicroUsd === undefined
        ? null
        : {
            modelId: "stub-decider",
            // Every question clears the support threshold, so the pre-gate skips
            // the paid reviewer and the decision call is the reviewer stage's
            // only spend.
            decide: (spec) =>
              Effect.succeed({
                answers: Object.fromEntries(
                  Object.keys(spec.questions).map((key) => [
                    key,
                    { type: "noul" as const, noul: 1 },
                  ]),
                ),
                cost: cost("stub-decider", overrides.pregateMicroUsd as number),
              }),
          },
  };
}
