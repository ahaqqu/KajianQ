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
 * `chat-prompts.ts` imports `DEFAULT_REFUSALS` from here through
 * `chat-reviewer.ts`'s re-export — the canonical refusal sentence is shared
 * with the generator's rule 1, and the detector matches these exact strings.
 */

/**
 * The default refusal language (the generator's ID/EN insufficiency text).
 * `chat-prompts.ts` imports this to instruct the generator to emit it verbatim —
 * the detector matches these exact strings, so the copy and the instruction must
 * not drift.
 */
export const DEFAULT_REFUSALS = {
  id: "tidak menemukan dalil yang memadai",
  en: "could not find adequate evidence",
} as const;

/** The refusal text a language resolves to (kept next to the prompts). */
export function refusalTextFor(
  language: import("./chat-prompts").ChatLanguage,
  reason: "ungrounded" | "reviewer",
): string {
  if (reason === "reviewer") {
    return language === "en"
      ? "the answer was not supported by the retrieved evidence"
      : "jawaban tidak didukung oleh dalil yang ditemukan";
  }
  return language === "en" ? DEFAULT_REFUSALS.en : DEFAULT_REFUSALS.id;
}

/**
 * True when the draft IS the canonical insufficiency refusal the generator was
 * instructed to emit verbatim (`chat-prompts.ts`). Both language markers are
 * detected: the model may answer in the wrong language, and a refusal in
 * either is still a refusal.
 */
export function isRefusalDraft(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes(DEFAULT_REFUSALS.id) || t.includes(DEFAULT_REFUSALS.en);
}

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
        `Question: ${context.query.intent}`,
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
