import { createKajianQAssembler } from "./chat-assembler";
import { createKajianQGenerator, type GeneratorProvider } from "./chat-generator";
import { createKajianQReviewer, type ReviewerProvider } from "./chat-reviewer";
export type { GeneratorProvider, ReviewerProvider };
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
  language: ChatLanguage;
  skipReviewer?: boolean;
}): ReturnType<typeof createKajianQAssembler> extends never
  ? never
  : {
      assembler: ReturnType<typeof createKajianQAssembler>;
      generator: ReturnType<typeof createKajianQGenerator>;
      reviewer: ReturnType<typeof createKajianQReviewer>;
    } {
  return {
    assembler: createKajianQAssembler(),
    generator: createKajianQGenerator({
      provider: deps.generatorProvider,
      language: deps.language,
    }),
    reviewer: createKajianQReviewer({
      provider: deps.reviewerProvider,
      ...(deps.skipReviewer !== undefined ? { skipLlm: deps.skipReviewer } : {}),
    }),
  };
}
