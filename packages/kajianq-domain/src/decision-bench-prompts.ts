import type { CitationCase, RelevanceCase, RerankCase } from "@app/contracts";

/**
 * Decision-bench prompt templates (ADR-0042): the per-task question wording
 * for the multilingual decision-model gate. Like the expansion micro-task's
 * prompts, these live in the domain pack — the eval engine receives them as
 * opaque template functions (thermo A1 discipline; the type is duplicated
 * here because the dependency direction is eval → domain, never the reverse).
 * The wording is deliberately language-neutral: the state carries the
 * passage in its own language, and judging "does this passage answer this
 * question" must not need the instructions translated per language — that
 * is itself part of what the gate measures.
 */

export const RELEVANCE_INSTRUCTIONS = "Does the passage answer the question?";

export const RELEVANCE_CRITERIA = {
  true: "The passage directly addresses or answers the question",
  false: "The passage is unrelated or does not answer the question",
} as const;

export const RERANK_INSTRUCTIONS =
  "Which candidate passage best answers the question? Pick exactly one candidate.";

export const CITATION_INSTRUCTIONS = "Does the passage genuinely support the claim, as stated?";

export const CITATION_CRITERIA = {
  true: "The passage states what the claim says it states",
  false: "The passage does not state or support the claim",
} as const;

/** Structurally identical to `@app/eval`'s DecisionBenchPrompts. */
export const DECISION_BENCH_PROMPTS = {
  relevance: {
    instructions: (_c: RelevanceCase) => RELEVANCE_INSTRUCTIONS,
    criteria: { ...RELEVANCE_CRITERIA },
  },
  rerank: {
    instructions: (_c: RerankCase) => RERANK_INSTRUCTIONS,
    criteria: (_c: RerankCase) => ({}),
  },
  citation: {
    instructions: (_c: CitationCase) => CITATION_INSTRUCTIONS,
    criteria: { ...CITATION_CRITERIA },
  },
} as const;
