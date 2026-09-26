import { createKajianQAssembler } from "./chat-assembler";
import { createKajianQGenerator, type GeneratorProvider } from "./chat-generator";
import { createKajianQReviewer, refusalTextFor, type ReviewerProvider } from "./chat-reviewer";
export type { GeneratorProvider, ReviewerProvider };
import type { Decider } from "@app/rag-core";
import type { ChatLanguage } from "./chat-prompts";

/**
 * Grouped factory for the three deterministic/local chat stages (assembler,
 * generator, reviewer) — a pure convenience barrel so the pipeline
 * composition module stays under the agentic import cap while each stage
 * keeps its own file and seam.
 */
export function createChatTailStages(deps: {
  generatorProvider: GeneratorProvider;
  reviewerProvider: ReviewerProvider | null;
  /** The reviewer's decision-model pre-gate; null = the key is not bound. */
  reviewerDecider: Decider | null;
  language: ChatLanguage;
  skipReviewer?: boolean;
  /** Streamed-delta observation hook (the HTTP edge forwards to SSE). */
  onDelta?: (delta: string) => void;
}): {
  assembler: ReturnType<typeof createKajianQAssembler>;
  generator: ReturnType<typeof createKajianQGenerator>;
  reviewer: ReturnType<typeof createKajianQReviewer>;
} {
  return {
    assembler: createKajianQAssembler(),
    generator: createKajianQGenerator({
      provider: deps.generatorProvider,
      language: deps.language,
      ...(deps.onDelta !== undefined ? { onDelta: deps.onDelta } : {}),
    }),
    reviewer: createKajianQReviewer({
      provider: deps.reviewerProvider,
      decider: deps.reviewerDecider,
      ...(deps.skipReviewer !== undefined ? { skipLlm: deps.skipReviewer } : {}),
      language: deps.language,
      // The refusal the user sees is in their language (acceptance criterion:
      // answer language matches question language).
      refusalText: (reason) => refusalTextFor(deps.language, reason),
    }),
  };
}
