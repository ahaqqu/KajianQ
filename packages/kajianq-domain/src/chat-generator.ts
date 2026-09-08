import { Effect } from "effect";
import type { CostRecord } from "@app/contracts";
import {
  RunContext,
  toStageError,
  type AssembledContext,
  type Draft,
  type Generator,
} from "@app/rag-core";
import type { KajianQFilters } from "./filters";
import { chatSystemPrompt, chatUserPrompt, type ChatLanguage } from "./chat-prompts";

/**
 * KajianQGenerator — stage 6 (spec §3.3): the quality-tier generator with the
 * strict grounding prompt, streaming-capable through the Provider seam. The
 * call's CostRecord is recorded to the run's trace sink (ADR-0021).
 */

export type GeneratorProvider = {
  generate(spec: {
    turns: readonly { role: string; content: string }[];
  }): Effect.Effect<{ text: string; cost: CostRecord }, unknown>;
};

export type KajianQGeneratorDeps = {
  provider: GeneratorProvider;
  language: ChatLanguage;
};

export function createKajianQGenerator(deps: KajianQGeneratorDeps): Generator<KajianQFilters> {
  return {
    generate: (context: AssembledContext<KajianQFilters>) =>
      toStageError(
        "generator",
        Effect.gen(function* () {
          const run = yield* RunContext;
          const reply = yield* deps.provider
            .generate({
              turns: [
                { role: "system", content: chatSystemPrompt(deps.language) },
                {
                  role: "user",
                  content: chatUserPrompt(
                    context.query.intent,
                    context.turns.map((t) => t.content).join("\n"),
                  ),
                },
              ],
            })
            .pipe(Effect.mapError((cause: unknown) => ({ cause })));
          run.record({
            stage: "generator",
            kind: "llm_call",
            detail: { purpose: "generate" },
            cost: reply.cost,
            at: run.now(),
          });
          const draft: Draft = { text: reply.text };
          return draft;
        }),
      ),
  };
}