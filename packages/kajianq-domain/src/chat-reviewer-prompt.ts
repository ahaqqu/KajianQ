import { Effect } from "effect";
import type { CostRecord } from "@app/contracts";
import type { AssembledContext } from "@app/rag-core";
import type { KajianQFilters } from "./filters";

/** Re-exported so the stage module stays inside the import cap. */
export type { KajianQFilters };

/**
 * The reviewer's prompt + message construction, split out of `chat-reviewer.ts`
 * for the same reason `chat-generator.ts` splits its draft helpers: the stage
 * file stays inside the agentic size limits while the prompt strings keep their
 * own named seam (`chat-reviewer-prompt.test.ts` pins them — the failure modes
 * it documents are silent, so the prompt must stay test-addressable).
 *
 * The refusal vocabulary this module used to carry now lives in
 * `chat-refusal.ts` (round B1 of the #443 review: this module reached 298
 * counted lines of the agentic hard cap of 300, and the branch needed a whole
 * commit to shave prose back under it). It is re-exported below so the stage
 * keeps ONE import statement for its whole reviewer seam — the stage sits at the
 * agentic 5-import cap — and every historical import surface keeps working. The
 * refusal logic itself has one owner: the module next to this one.
 */
export {
  DEFAULT_REFUSALS,
  isEarnedRefusal,
  isRefusalDraft,
  isRefusalOnly,
  REFUSAL_DRAFT_DECISIONS,
  refusalDraftDecision,
  refusalTextFor,
  type RefusalDraftDecision,
  type RefusalTrigger,
} from "./chat-refusal";

/**
 * The reviewer's system prompt: the grounding rules for the cross-vendor gate.
 * Exported with `buildReviewMessages` so a test or an offline probe exercises
 * the exact prompt production sends.
 *
 * "Declines to answer" is the symmetric backstop to the generator's rule 1:
 * on gs-v0-019 (Staging, 2026-09-13) the generator disobeyed rule 1 and its
 * grounded "only Allah knows" draft passed the gate, failing the trap. The
 * case stays narrow and the guarantees above are unchanged (SPECS §3.3).
 */
export const REVIEWER_SYSTEM_PROMPT = [
  "You are a faithfulness reviewer for a grounded Islamic knowledge answer.",
  "Given the question, the draft answer, and the retrieved evidence, reply with ONLY JSON:",
  '{"verdict": "pass" | "fail", "reason": "..."}',
  "The evidence is the exact context the answer was given: each block is the Arabic",
  "original, the machine-translation label, the translation where the source has it,",
  "and the block's own citation label.",
  "Translating a quoted passage into the answer's language, quoting it, and naming the",
  "citation labels the evidence itself carries are REQUIRED of the answer and are never",
  "grounds for failure: a label that appears in the evidence is supported by definition,",
  "and a translation of a quoted passage is not a new claim.",
  "The question is the user's own wording. Using a term the QUESTION itself uses for a",
  "passage the evidence contains (for example, presenting a retrieved verse as the one",
  "the question names) is not an unsupported claim.",
  "Fail ONLY when the answer asserts something the evidence does not support, contradicts",
  "the evidence, cites a source absent from the evidence, or declines to answer. A draft",
  "declines to answer when the question demands one specific fact (a date, year, number,",
  "name, or a ruling on a specific case) the evidence does not contain, and the draft",
  "instead describes, explains, or contextualizes what the evidence does or does not say",
  'about that fact (for example, "no date is stated; only Allah knows"). Such a draft',
  "asserts nothing unsupported yet still FAILS, so the user receives a refusal instead",
  "of an essay. This fail case is narrow: a draft that answers the question from what",
  "the evidence contains passes, and a partial answer or an imprecise wording is not a",
  "fail.",
].join("\n");

/**
 * The reviewer's evidence + draft turns. The evidence is the assembler's own
 * context turn — the exact text the Generator was asked to answer from — so the
 * gate cannot fail an answer for quoting what the prompt actually
 * provided. It used to re-render `- ${chunk.text}`, which for a fallback-track
 * hit is the translation only: the Generator saw the Arabic layer and the
 * Reviewer rejected answers that quoted it as "absent from the evidence".
 *
 * The question rides along so the gate can tell the user's own term (a name
 * the answer is entitled to reuse) from a claim the evidence does not carry.
 *
 * The spec's `personalData` is added by the CALLER (`chat-reviewer.ts`): the
 * question and draft are the user's personal data, and the flag belongs at
 * the serving call site, not inside prompt construction (ADR-0043).
 *
 * Using the assembled turn (rather than re-rendering the chunks) makes the
 * parity structural: one source of truth, and history rides its own turn, so
 * the last user turn is the evidence.
 */
export function buildReviewMessages(
  context: AssembledContext<KajianQFilters>,
  draftText: string,
): { role: string; content: string }[] {
  const evidence = context.turns.filter((turn) => turn.role === "user").at(-1)?.content ?? "";
  return [
    { role: "system", content: REVIEWER_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        // The verbatim question (`sourceText`), never the router's intent: the
        // reviewer judges the draft against what the user actually asked, and
        // the engine stamps that text onto the routed query (ADR-0018).
        `Question: ${context.query.sourceText}`,
        "",
        "Evidence:",
        evidence,
        "",
        "Draft answer:",
        draftText,
      ].join("\n"),
    },
  ];
}

/**
 * The reviewer LLM's typed seam. `personalData` is REQUIRED (never optional):
 * the reviewer prompt embeds the user's question and the drafted answer —
 * personal data (ADR-0043 Consequences). A non-optional field makes dropping
 * the flag a compile error at the call site, and the flag makes
 * `FallbackProvider` skip free-tier candidates for the call.
 */
export type ReviewerLlmSeam = {
  generate(spec: {
    turns: readonly { role: string; content: string }[];
    personalData: true;
  }): Effect.Effect<{ text: string; cost: CostRecord }, unknown>;
};
