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
 * True when the canonical insufficiency refusal SENTENCE appears in the draft,
 * in either language (a substring match, `chat-prompts.ts` instructs the
 * generator to emit it verbatim). The model may answer in the wrong language,
 * and a refusal in either is still a refusal.
 *
 * It is deliberately NOT "this text is a refusal": the same sentence is the
 * tail of a HYBRID draft — a grounded partial answer that runs into it (#436,
 * #439) — and the head of an ASSERTING refusal draft whose own text asserts
 * something and cites nothing (#443). Which decision each shape earns is
 * `refusalDraftDecision`'s, below: all three skip the paid reviewer, but only
 * the shape that declines is delivered as the model wrote it, because the
 * deterministic rules the spec marks "Always" are computed for whatever text
 * actually ships, and a text that neither cites nor declines is not a decline
 * the machinery happened to see no citations in. Renaming or narrowing this
 * predicate silently moves that boundary, which is why the hybrid half is
 * pinned by `chat-reviewer-evidence.test.ts` and `chat-dhaif-warning.test.ts`
 * and the asserting half by `chat-reviewer-prompt.test.ts`.
 */
export function isRefusalDraft(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes(DEFAULT_REFUSALS.id) || t.includes(DEFAULT_REFUSALS.en);
}

/**
 * True when the draft is the refusal and NOTHING else (#443): every sentence of
 * it carries the canonical sentence, so what surrounds the refusal is its own
 * framing ("Mohon maaf, … untuk pertanyaan ini.") and never a claim of its own.
 * This is the DETERMINISTIC signal the earned-refusal exemption was missing —
 * the decline backstop, the symmetric counterpart to the reviewer's
 * "declines to answer" case, and the reason a citation-free draft that asserts
 * can no longer pass as a decline because the machinery saw no citations.
 *
 * It is a SHAPE test, deliberately not a claim classifier: the product cannot
 * read assertions, so the exemption is granted only to a text that adds nothing
 * of its own. Any text this does not recognise takes the refusal backstop,
 * whose delivery is the product's own refusal — the safe direction, because a
 * refusal the reader recognises is never worse than an assertion nobody
 * vouches for (SPECS §1.5 boundary 2), while decorating an assertion leaves the
 * assertion standing (SPECS §2.2).
 *
 * Its limits are recorded rather than hidden, both taking that same safe
 * direction: a draft that folds its assertion into the refusal's own sentence
 * is not distinguished from framing here, and neither is a multi-sentence
 * polite decline (a second sentence without the sentence is not the refusal-only
 * shape). Both ship the product's refusal, not the model's words.
 */
export function isRefusalOnly(text: string): boolean {
  const sentences = text
    .split(/[.!?]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
  return sentences.length > 0 && sentences.every((sentence) => isRefusalDraft(sentence));
}

/**
 * The EARNED refusal shape (#439, #443): the canonical sentence in a draft that
 * cites nothing AND declines — the shape that ships verbatim and invents no
 * warning. `citations` is the deterministic validator's partition of the
 * draft's spans (`chat-citation-validator.ts`): a refused span lands in
 * `ungrounded`, an accepted one contributes at least one label to `grounded`,
 * so both lists empty is the positive reading of "this draft cites nothing"
 * and `isRefusalOnly` the positive reading of "this draft declines". Reading
 * `grounded.length === 0` alone means the weaker "no grounded span", true only
 * while the stage's ungrounded gate returns first — a reorder would ship a
 * refused text verbatim.
 *
 * The classification may skip the PAID reviewer (ADR-0009 cost discipline); it
 * may not skip a rule the spec makes `Always` (SPECS §2.2), which is why a
 * HYBRID — the sentence riding an answer that cites something — funnels through
 * the stage's `withRules` instead, and it may not skip the reader's ability to
 * tell a refusal from prose (#443), which is why the shape that cites nothing
 * but asserts is delivered as the product's own refusal. The shape vocabulary
 * is normative in `CONTEXT.md` (Refusal).
 */
export function isEarnedRefusal(
  text: string,
  citations: { grounded: readonly string[]; ungrounded: readonly string[] },
): boolean {
  return (
    isRefusalDraft(text) &&
    citations.grounded.length === 0 &&
    citations.ungrounded.length === 0 &&
    isRefusalOnly(text)
  );
}

/**
 * What the reviewer stage DOES with a draft that carries the canonical refusal
 * sentence, and what its `refusal` event says about it. The stage records
 * `trigger`/`reason` verbatim and delivers `delivery` — so the decision, its
 * trace vocabulary and the delivered text have one owner, beside the predicate
 * that decides them (round B1 of the #441 review moved the decision here for
 * exactly this reason, and the stage's own file is inside the agentic line
 * cap).
 */
export type RefusalDraftDecision = {
  /** The shape the draft is, in `CONTEXT.md`'s Refusal vocabulary. */
  shape: "pure_refusal" | "hybrid_refusal" | "asserting_refusal";
  /** The `refusal` event's machine-readable trigger, like its sibling paths'. */
  trigger: "generator_refusal" | "asserting_refusal_draft";
  /** The `refusal` event's human-readable reason. */
  reason: string;
  /**
   * What is delivered: the draft's own text (`draft`), the draft through the
   * deterministic rules (`rules`), or the product's own refusal text
   * (`product_refusal` — the caller supplies its copy for the `ungrounded`
   * reason). No delivery is "record nothing": every shape records its event.
   */
  delivery: "draft" | "rules" | "product_refusal";
};

/**
 * The three outcomes, one per shape. `pure_refusal` and `hybrid_refusal` keep
 * #439's decisions unchanged (verbatim, and rules-without-the-paid-reviewer);
 * `asserting_refusal` is #443's, and its delivery is the product's refusal, so
 * no rule is invented for a text that cites nothing and no warning line is
 * appended to one (the #285 pin).
 */
export const REFUSAL_DRAFT_DECISIONS = {
  pure_refusal: {
    shape: "pure_refusal",
    trigger: "generator_refusal",
    reason: "generator emitted the canonical insufficiency refusal",
    delivery: "draft",
  },
  hybrid_refusal: {
    shape: "hybrid_refusal",
    trigger: "generator_refusal",
    reason: "generator emitted the canonical insufficiency refusal",
    delivery: "rules",
  },
  asserting_refusal: {
    shape: "asserting_refusal",
    trigger: "asserting_refusal_draft",
    reason:
      "the draft carries the refusal sentence but asserts content of its own and cites nothing",
    delivery: "product_refusal",
  },
} as const satisfies Record<string, RefusalDraftDecision>;

/**
 * Which shape the draft is and what it earns, or `null` when the draft does not
 * carry the sentence at all (the stage's ordinary path). The stage keeps this
 * as its one refusal decision; the reasoning lives here with the predicates.
 *
 * The ungrounded half of the partition is read FIRST, before the grounded half.
 * The stage refuses an ungrounded span before it classifies anything, so that
 * ordering is unreachable in the stage's own order — it is read anyway so a
 * reorder cannot ship a refused draft: an ungrounded span takes the asserting
 * shape, whose delivery is the product's refusal, never the draft's own words.
 */
export function refusalDraftDecision(
  text: string,
  citations: { grounded: readonly string[]; ungrounded: readonly string[] },
): RefusalDraftDecision | null {
  if (!isRefusalDraft(text)) return null;
  if (citations.ungrounded.length > 0) return REFUSAL_DRAFT_DECISIONS.asserting_refusal;
  if (isEarnedRefusal(text, citations)) return REFUSAL_DRAFT_DECISIONS.pure_refusal;
  if (citations.grounded.length > 0) return REFUSAL_DRAFT_DECISIONS.hybrid_refusal;
  return REFUSAL_DRAFT_DECISIONS.asserting_refusal;
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
