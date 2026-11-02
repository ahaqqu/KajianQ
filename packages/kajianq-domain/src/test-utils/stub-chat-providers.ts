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
  /**
   * The router's reply as a function of the turns it was sent. A test that needs
   * the reading to depend on what the prompt carried — a follow-up resolved from
   * the prior turns — supplies this instead of `routerText`; `routerText` wins
   * only when this is absent.
   */
  routerReply?: (turns: readonly { role: string; content: string }[]) => string;
  answerText?: string;
  /** Explicit delta sequence (overrides `answerText` chunking). */
  streamDeltas?: readonly string[];
  /**
   * One embedding vector per text, as a function of the text. Absent = the one
   * fixed vector every routed sub-query shared; supplied = the retrieval really
   * depends on the query text, so a test can assert which sub-query found a row.
   */
  embedFor?: (text: string) => readonly number[];
  /**
   * Scripted readings, one per generator call, in call order. Supplying it
   * means the test expects exactly these readings: a call past the script fails
   * the test rather than being served `answerText`. A refusal path scripts the
   * first reading and the reread differently, which one `answerText` cannot
   * express.
   */
  generatorReplies?: readonly string[];
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
  /** Wire the retrieval rerank with this call's micro-USD. Absent = no decider;
   * the stub answers a Choice question with a uniform distribution over the
   * offered candidates, so the rerank applies and keeps the fused order. */
  rerankMicroUsd?: number;
};

/** A decision answer per question: Noul always clears; Choice gets a uniform
 * distribution whose pick is a (tied) maximum, so the read is usable. */
function stubAnswers(
  spec: import("@app/rag-core").DecisionSpec,
): Record<string, import("@app/rag-core").DecisionAnswer> {
  return Object.fromEntries(
    Object.entries(spec.questions).map(([key, question]) => {
      if (question.type !== "choice") return [key, { type: "noul" as const, noul: 1 }];
      const keys = Object.keys(question.criteria);
      const probability = keys.length > 0 ? 1 / keys.length : 0;
      return [
        key,
        {
          type: "choice" as const,
          choice: keys[0] ?? "",
          probabilities: Object.fromEntries(keys.map((option) => [option, probability])),
          confidence: 1,
        },
      ];
    }),
  );
}

export type StubGeneratorCall = readonly { role: string; content: string }[];

export function createStubChatProviders(overrides: StubChatProviderOverrides = {}): {
  routerProvider: RouterProvider;
  generatorProvider: GeneratorProvider;
  reviewerProvider: ReviewerProvider;
  embedder: RetrieverEmbedder;
  /** The turns each generator call received, in call order — the directed
   * reread is a different user turn, so this is how a caller asserts which
   * reading it got without re-plumbing the stub. */
  generatorCalls: readonly StubGeneratorCall[];
  /**
   * The decision-model screens are unwired by default: the stub models an
   * environment where the decision vendor's key is absent, so pipeline tests
   * that do not opt in exercise today's paths without them.
   */
  reviewerDecider: import("@app/rag-core").Decider | null;
  rerankDecider: import("@app/rag-core").Decider | null;
} {
  const answerText = overrides.answerText ?? "Jawaban berdasar konteks.";
  const scripted = overrides.generatorReplies;
  let readings = 0;
  const nextReading = (): string => {
    if (scripted === undefined) return answerText;
    const reading = scripted[readings];
    if (reading === undefined) {
      throw new Error(
        `stub generator: call ${readings + 1} has no scripted reading (scripted ${scripted.length})`,
      );
    }
    readings += 1;
    return reading;
  };
  const deltasFor = (): readonly string[] => overrides.streamDeltas ?? [nextReading()];
  const embedFor = overrides.embedFor;
  const generatorCalls: StubGeneratorCall[] = [];
  const generatorFails = overrides.generatorFails === true;
  const generatorProvider: GeneratorProvider = {
    generate: (spec) => {
      generatorCalls.push(spec.turns);
      return generatorFails
        ? Effect.fail(new Error("stub generator failure"))
        : Effect.succeed({
            text: nextReading(),
            cost: cost("stub-generator", 2),
          });
    },
    ...(overrides.noStream === true
      ? {}
      : {
          stream: (spec) => {
            generatorCalls.push(spec.turns);
            return generatorFails
              ? Effect.fail(new Error("stub generator failure"))
              : Effect.succeed({
                  deltas: Stream.fromIterable(deltasFor()),
                  cost: () => Effect.succeed(cost("stub-generator", 2)),
                });
          },
        }),
  };
  return {
    routerProvider: {
      generate: (spec) =>
        Effect.succeed({
          text:
            overrides.routerReply?.(spec.turns) ??
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
    generatorCalls,
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
      embed: (spec) =>
        Effect.succeed({
          // The fixed vector is the default so every existing case keeps the one
          // shared search; `embedFor` makes the vector a function of the text so a
          // case can prove which sub-query reached which row.
          vectors:
            embedFor === undefined ? [[1, 0, 0]] : spec.texts.map((text) => [...embedFor(text)]),
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
    rerankDecider:
      overrides.rerankMicroUsd === undefined
        ? null
        : {
            modelId: "stub-decider",
            decide: (spec) =>
              Effect.succeed({
                answers: stubAnswers(spec),
                cost: cost("stub-decider", overrides.rerankMicroUsd as number),
              }),
          },
  };
}
