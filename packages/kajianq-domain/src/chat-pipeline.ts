import { Effect } from "effect";

import {
  type Answer,
  runPipeline,
  type PipelineStages,
  type RunConfig,
  type RunOptions,
  type StageError,
  type StoreError,
  type Decider,
} from "@app/rag-core";
import { createKajianQRouter, type RouterProvider } from "./chat-router";
import { createKajianQRetriever, type RetrieverEmbedder, type StoreBridge } from "./chat-retriever";
import { createChatTailStages, type GeneratorProvider, type ReviewerProvider } from "./chat-stages";

/**
 * Pipeline composition for the KajianQ chat flow: build the five `PipelineStages` from
 * injected seams and run them through the engine's `runPipeline` runner — never
 * hand-assembled traces (ADR-0021). Language lives on the deps, so the HTTP layer
 * resolves it once per request.
 */

export type ChatPipelineDeps = {
  routerProvider: RouterProvider;
  generatorProvider: GeneratorProvider;
  reviewerProvider: ReviewerProvider | null;
  /** The reviewer's decision-model pre-gate: null when the decision vendor's key is not
   * bound, in which case the reviewer runs without it. Required, not optional — a wiring
   * that forgets it would lose the pre-gate silently, so it must fail to compile. */
  reviewerDecider: Decider | null;
  embedder: RetrieverEmbedder;
  store: Pick<
    import("@app/infra").RagStore,
    "similaritySearch" | "listDocChildrenByParentSourceKey" | "listDocChildNeighboursByChildIds"
  >;
  bridge: StoreBridge;
  language: import("./chat-prompts").ChatLanguage;
  retrieverLimit?: number;
  /** ADR-0045 scope-expansion budget: at most this many children of a named surah join the
   * fused hits; absent = the domain default, set from deployment config at the composition
   * root so the cost of a scoped query is a knob, not a literal. */
  scopeExpansionCap?: number;
  /** Skip the reviewer LLM call (eval refusal cases, budget-capped runs). */
  skipReviewer?: boolean;
  /** Collector for LLM costs that ride the retrieval stage (embed call). */
  onCost?: (cost: import("@app/contracts").CostRecord) => void;
  /** Streamed-generation hook: each delta as the vendor produces it. The reviewer gates
   * the whole draft before any of it is delivered. */
  onDelta?: (delta: string) => void;
  /** Prior conversation turns for follow-up questions, oldest first; the assembler renders
   * them. Absent = single-turn. */
  history?: readonly { role: string; content: string }[];
};

export function buildChatStages(
  deps: ChatPipelineDeps,
): PipelineStages<import("./filters").KajianQFilters> {
  const router = createKajianQRouter(deps.routerProvider);
  const retriever = createKajianQRetriever({
    store: deps.store as Parameters<typeof createKajianQRetriever>[0]["store"],
    embedder: deps.embedder,
    bridge: deps.bridge,
    ...(deps.retrieverLimit !== undefined ? { limit: deps.retrieverLimit } : {}),
    ...(deps.scopeExpansionCap !== undefined ? { scopeExpansionCap: deps.scopeExpansionCap } : {}),
    onEmbedCost: (cost) => deps.onCost?.(cost),
  });
  const tail = createChatTailStages({
    generatorProvider: deps.generatorProvider,
    reviewerProvider: deps.reviewerProvider,
    reviewerDecider: deps.reviewerDecider,
    language: deps.language,
    ...(deps.skipReviewer !== undefined ? { skipReviewer: deps.skipReviewer } : {}),
    ...(deps.onDelta !== undefined ? { onDelta: deps.onDelta } : {}),
  });
  return {
    router,
    retriever,
    assembler: tail.assembler,
    generator: tail.generator,
    reviewer: tail.reviewer,
  };
}

/** Run the chat pipeline through the engine runner. `onCost` receives every LLM/embed cost
 * recorded during the run — the embed stage's costs arrive via the retriever hook — so the
 * HTTP layer can attribute spend to the answer. */
export function runChatPipeline(
  deps: ChatPipelineDeps,
  query: { text: string; filters?: import("./filters").KajianQFilters },
  config: RunConfig<import("./filters").KajianQFilters> = {},
  options: RunOptions = {},
): Effect.Effect<Answer, import("@app/rag-core").StageError> {
  const stages = buildChatStages(deps);
  // Follow-up context rides `Query.history` (ADR-0018), attached here rather than on the
  // deps, so one deps object serves a session while each question carries its own window.
  const withHistory = {
    ...query,
    ...(deps.history !== undefined ? { history: deps.history } : {}),
  };
  const withCosts: RunOptions = {
    ...options,
    onFailedTrace: (trace) => {
      for (const event of trace.events) {
        if (event.cost) deps.onCost?.(event.cost);
      }
      options.onFailedTrace?.(trace);
    },
  };
  return runPipeline<import("./filters").KajianQFilters>(stages, withHistory, config, withCosts);
}

/**
 * Run one Effect-signatured store call to a promise — the single effect bridge the HTTP
 * edge may use (apps keep no direct effect dependency; the bridge lives in the domain).
 * Rejects with the typed `StoreError`.
 */
export function runStoreEffect<A>(effect: Effect.Effect<A, StoreError>): Promise<A> {
  return Effect.runPromise(effect);
}
export function runChatPipelinePromise(
  deps: ChatPipelineDeps,
  query: { text: string; filters?: import("./filters").KajianQFilters },
  config: RunConfig<import("./filters").KajianQFilters> = {},
  options: RunOptions = {},
): Promise<Answer> {
  return Effect.runPromise(runChatPipeline(deps, query, config, options));
}
