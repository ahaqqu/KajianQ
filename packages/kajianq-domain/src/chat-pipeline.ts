import { Effect } from "effect";
import type { CostRecord } from "@app/contracts";
import type { RagStore } from "@app/infra";
import {
  type Answer,
  runPipeline,
  type PipelineStages,
  type RunConfig,
  type RunOptions,
  type StageError,
} from "@app/rag-core";
import { createKajianQRouter, type RouterProvider } from "./chat-router";
import {
  createKajianQRetriever,
  type RetrieverEmbedder,
  type RetrieverStore,
  type StoreBridge,
} from "./chat-retriever";
import { createKajianQAssembler } from "./chat-assembler";
import { createKajianQGenerator, type GeneratorProvider } from "./chat-generator";
import { createKajianQReviewer, type ReviewerProvider } from "./chat-reviewer";
import type { KajianQFilters } from "./filters";
import type { ChatLanguage } from "./chat-prompts";

/**
 * Pipeline composition for the KajianQ chat flow (#8): builds the five
 * `PipelineStages` from injected seams (Provider roles, RagStore, embedder,
 * store bridge) and runs them through the engine's `runPipeline` runner —
 * never hand-assembled traces (ADR-0021). Language lives on the deps, not the
 * query, so the HTTP layer resolves it once per request.
 */

export type ChatPipelineDeps = {
  routerProvider: RouterProvider;
  generatorProvider: GeneratorProvider;
  reviewerProvider: ReviewerProvider | null;
  embedder: RetrieverEmbedder;
  store: Pick<RagStore, "similaritySearch">;
  /** Runs a store Effect to a promise (composition-root bridge). */
  bridge: StoreBridge;
  language: ChatLanguage;
  retrieverLimit?: number;
  /** Skip the reviewer LLM call (eval refusal cases, budget-capped runs). */
  skipReviewer?: boolean;
  /** Collector for LLM costs that ride the retrieval stage (embed call). */
  onCost?: (cost: CostRecord) => void;
};

export function buildChatStages(deps: ChatPipelineDeps): PipelineStages<KajianQFilters> {
  const router = createKajianQRouter(deps.routerProvider);
  const retriever = createKajianQRetriever({
    store: deps.store as RetrieverStore,
    embedder: deps.embedder,
    bridge: deps.bridge,
    ...(deps.retrieverLimit !== undefined ? { limit: deps.retrieverLimit } : {}),
    onEmbedCost: (cost) => deps.onCost?.(cost),
  });
  const assembler = createKajianQAssembler();
  const generator = createKajianQGenerator({
    provider: deps.generatorProvider,
    language: deps.language,
  });
  const reviewer = createKajianQReviewer({
    provider: deps.reviewerProvider,
    ...(deps.skipReviewer !== undefined ? { skipLlm: deps.skipReviewer } : {}),
  });
  return { router, retriever, assembler, generator, reviewer };
}

/**
 * Run the chat pipeline through the engine runner. `onCost` receives every
 * LLM/embed cost recorded during the run (the embed stage's costs arrive via
 * the retriever hook) so the HTTP layer can attribute spend to the answer.
 */
export function runChatPipeline(
  deps: ChatPipelineDeps,
  query: { text: string; filters?: KajianQFilters },
  config: RunConfig<KajianQFilters> = {},
  options: RunOptions = {},
): Effect.Effect<Answer, import("@app/rag-core").StageError> {
  const stages = buildChatStages(deps);
  const withCosts: RunOptions = {
    ...options,
    onFailedTrace: (trace) => {
      for (const event of trace.events) {
        if (event.cost) deps.onCost?.(event.cost);
      }
      options.onFailedTrace?.(trace);
    },
  };
  return runPipeline<KajianQFilters>(stages, query, config, withCosts);
}

/**
 * Promise-shaped bridge for the HTTP edge (ADR-0027 decision 3: apps keep no
 * direct effect dependency — the bridge lives in the domain, which owns the
 * engine's effect version). Rejects with the typed `StageError`; a failed
 * run's trace events still reach `onCost`/`onFailedTrace` via `withCosts`.
 */
export function runChatPipelinePromise(
  deps: ChatPipelineDeps,
  query: { text: string; filters?: KajianQFilters },
  config: RunConfig<KajianQFilters> = {},
  options: RunOptions = {},
): Promise<Answer> {
  return Effect.runPromise(runChatPipeline(deps, query, config, options));
}