import type { ChatLanguage } from "./chat-prompts";

/**
 * The refusal vocabulary — one owner for the canonical insufficiency sentence,
 * the predicates that read a draft for it, the table that decides what each
 * shape earns, and the trace vocabulary that decision records.
 *
 * Split out of `chat-reviewer-prompt.ts` (round B1 of the #443 review): that
 * module reached 298 counted lines of the agentic hard cap of 300, and the
 * branch needed a whole commit to shave prose back under it. This module is the
 * same seam the repo made when the prompt module was split out of
 * `chat-reviewer.ts`; the reviewer's prompt and message construction — a
 * different concern with its own named seam — stay in the prompt module, which
 * re-exports these names so the stage keeps one import statement (the stage
 * sits at the agentic 5-import cap) and every historical import surface keeps
 * working.
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

/** The two sentences `chat-prompts.ts` instructs the generator to emit verbatim. */
const CANONICAL_SENTENCES = [DEFAULT_REFUSALS.id, DEFAULT_REFUSALS.en];

/** The refusal text a language resolves to (kept beside the sentence it stands in for). */
export function refusalTextFor(language: ChatLanguage, reason: "ungrounded" | "reviewer"): string {
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
 * and the asserting half by `chat-refusal.test.ts`.
 */
export function isRefusalDraft(text: string): boolean {
  const t = text.toLowerCase();
  return CANONICAL_SENTENCES.some((sentence) => t.includes(sentence));
}

/**
 * What ends a sentence for the refusal-only shape test: terminal punctuation in
 * either script (`[.!?؟۔]+`), a blank line — a paragraph is its own statement —
 * and the start of a list item's own line. An intra-paragraph line WRAP is not a
 * boundary, so the pinned wrapped decline (`"Mohon maaf,\nkami …\nuntuk
 * pertanyaan ini."`) stays one sentence and ships byte-identical.
 *
 * Newlines were previously not boundaries at all, which let an unterminated
 * assertion, a list body and a non-`.`-terminated Arabic line keep the exemption
 * and ship the model's own words (review A1 of #443).
 */
const SENTENCE_BOUNDARIES = /[.!?؟۔]+|\r?\n[ \t]*\r?\n|^[ \t]*(?:[-*•]|\d+[.)])[ \t]+/mu;

/**
 * The framing vocabulary: the only words the exemption may ignore, because the
 * product itself pins them around the canonical sentence and none of them can
 * carry a claim — an apology, the speaker, the pointer to the question. It is
 * the #285 floor's frame in both languages ("Mohon maaf, kami … untuk pertanyaan
 * ini." / "Sorry, we … for this question."), and it is EXHAUSTIVE: any other
 * word is content of the model's own and takes the refusal backstop (#452).
 *
 * The sentence's own vocabulary is deliberately NOT here — admitting
 * `menemukan`, `dalil` or `memadai` would grant the exemption to the sentence
 * with its negation dropped, `"Kami menemukan dalil yang memadai."`, the
 * opposite claim written in the refusal's own words.
 *
 * One space-separated string rather than an array of literals: the words cost a
 * line each when broken, and this module sits under the agentic 300-line cap.
 */
const FRAMING_WORDS = new Set(
  "mohon maaf kami untuk pertanyaan ini sorry we for this question".split(" "),
);

/** True when every word of a residue is one the product pins as framing. */
function isFraming(residue: string): boolean {
  return (residue.match(/[\p{L}\p{N}]+/gu) ?? []).every((word) => FRAMING_WORDS.has(word));
}

/**
 * True when one sentence of the draft carries nothing but the canonical
 * sentence and the framing — a sentence carrying no canonical occurrence at all
 * ("Mohon maaf." standing alone) must be framing-only, which is what keeps a
 * multi-sentence polite decline shipping. Every canonical occurrence is
 * stripped, and the residue is read as words (`[\p{L}\p{N}]+`, so a
 * digit-leading token like `2026`, or a citation label, is content and never
 * framing).
 */
function isRefusalSegment(sentence: string): boolean {
  let residue = sentence.toLowerCase();
  for (const canonical of CANONICAL_SENTENCES) {
    residue = residue.split(canonical).join(" ");
  }
  return isFraming(residue);
}

/**
 * True when the draft is the refusal and NOTHING else (#443, #452): it carries
 * the canonical sentence, and every word beside it is one the product itself
 * pins as framing — so what surrounds the refusal is its own frame ("Mohon
 * maaf, … untuk pertanyaan ini.") and never a claim of its own. This is the
 * DETERMINISTIC signal the earned-refusal exemption was missing — the decline
 * backstop, the symmetric counterpart to the reviewer's "declines to answer"
 * case, and the reason a citation-free draft that asserts can no longer pass as
 * a decline because the machinery saw no citations.
 *
 * It is a SHAPE test, deliberately not a claim classifier: any text it does not
 * recognise takes the refusal backstop, whose delivery is the product's own
 * refusal — a refusal the reader recognises is never worse than an assertion
 * nobody vouches for (SPECS §1.5 boundary 2), while decorating an assertion
 * leaves the assertion standing (SPECS §2.2). The fold is why vocabulary closes
 * it rather than a fourth boundary (#452): an assertion inside the refusal's
 * OWN sentence is the floor's own shape — `"<clause>, <connector> kami
 * <sentence>."` — and only vocabulary separates the claim (`haditsnya`,
 * `sahih`, `namun`) from the frame. Both directions are pinned in
 * `chat-refusal.test.ts`.
 */
export function isRefusalOnly(text: string): boolean {
  if (!isRefusalDraft(text)) return false;
  const sentences = text
    .split(SENTENCE_BOUNDARIES)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
  return sentences.length > 0 && sentences.every(isRefusalSegment);
}

/**
 * The EARNED refusal shape (#439, #443): the canonical sentence in a draft that
 * cites nothing AND declines — the shape that ships verbatim and invents no
 * warning. `citations` is the deterministic validator's partition of the
 * draft's spans (`chat-citation-validator.ts`): a refused span lands in
 * `ungrounded`, an accepted one contributes at least one label to `grounded`,
 * so both lists empty is the positive reading of "this draft cites nothing"
 * and `isRefusalOnly` the positive reading of "this draft declines". Reading
 * `grounded.length === 0` alone means the weaker "no grounded span" — which is
 * why `refusalDraftDecision` reads the ungrounded half first as its own row: a
 * single predicate cannot carry the order, so the decision that does read both
 * halves owns the exemption.
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
 * The `refusal` event's machine-readable trigger vocabulary — one home for all
 * four (two were union literals here and two were written inline by the stage,
 * round A2 of the #443 review). `generator_refusal` covers both sentence-carrying
 * shapes that return the draft; every other trigger REPLACES the delivered text
 * with product copy. That is the invariant `traceRefused` in
 * `apps/api/src/lib/chat-trace.ts` relies on.
 */
export type RefusalTrigger =
  | "generator_refusal"
  | "ungrounded_citation"
  | "reviewer_fail"
  | "asserting_refusal_draft";

/**
 * What the refusal path DOES with a draft that reached it, and what its
 * `refusal` event says about it: the stage records `trigger`/`reason` verbatim
 * and delivers `delivery`, so the decision, its trace vocabulary and the
 * delivered text have one owner, beside the predicate that decides them.
 */
export type RefusalDraftDecision = {
  /**
   * The row's shape, in `CONTEXT.md`'s Refusal vocabulary. Three rows share the
   * canonical sentence (`pure_refusal`, `hybrid_refusal`, `asserting_refusal`);
   * `ungrounded_citation` is the deterministic gate's own refusal and is read
   * without the sentence — a fabricated citation is refused whether or not the
   * draft also declines.
   */
  shape: "pure_refusal" | "hybrid_refusal" | "asserting_refusal" | "ungrounded_citation";
  /** The `refusal` event's machine-readable trigger (see `RefusalTrigger`). */
  trigger: RefusalTrigger;
  /** The `refusal` event's human-readable reason. */
  reason: string;
  /**
   * What is delivered: the draft's own text (`draft`), the draft through the
   * deterministic rules (`rules`), or the product's own refusal text
   * (`product_refusal` — the caller supplies its copy). No delivery is "record
   * nothing": every row records its event.
   */
  delivery: "draft" | "rules" | "product_refusal";
};

/**
 * The four rows, one per outcome. `ungrounded_citation` is the gate's own,
 * first and independent of the sentence; `pure_refusal` and `hybrid_refusal`
 * keep #439's decisions unchanged (verbatim, and rules-without-the-paid-
 * reviewer); `asserting_refusal` is #443's, and its delivery is the product's
 * refusal, so no rule is invented for a text that cites nothing and no warning
 * line is appended to one (the #285 pin).
 */
export const REFUSAL_DRAFT_DECISIONS = {
  ungrounded_citation: {
    shape: "ungrounded_citation",
    trigger: "ungrounded_citation",
    // The refused labels are appended per draft by `refusalDraftDecision`: the
    // reason names the span that was refused, not the row.
    reason: "citation(s) not present in retrieved context",
    delivery: "product_refusal",
  },
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
 * Which row the draft is and what it earns, or `null` when neither the
 * deterministic gate nor the sentence has anything to say (the stage's ordinary
 * path). The stage keeps this as its one refusal decision; the reasoning lives
 * here with the predicates.
 *
 * The ungrounded half of the partition is read FIRST, as the table's own first
 * row and independently of `isRefusalDraft`: an ordinary fabricated-citation
 * draft — no refusal sentence at all — is refused here too, so a stage reordered
 * to consult this decision first cannot reach the rules or the reviewer for a
 * refused span, and a MIXED partition (a grounded and an ungrounded span) cannot
 * take the hybrid row and ship the fabrication. That row used to be a separate,
 * earlier branch in the stage, which made the order a convention split across
 * two call sites and left the stage's branch carrying the refusal reason of a
 * draft that carried no span (review A2 of #443).
 */
export function refusalDraftDecision(
  text: string,
  citations: { grounded: readonly string[]; ungrounded: readonly string[] },
): RefusalDraftDecision | null {
  if (citations.ungrounded.length > 0) {
    return {
      ...REFUSAL_DRAFT_DECISIONS.ungrounded_citation,
      reason: `${REFUSAL_DRAFT_DECISIONS.ungrounded_citation.reason}: ${citations.ungrounded.join(", ")}`,
    };
  }
  if (!isRefusalDraft(text)) return null;
  if (isEarnedRefusal(text, citations)) return REFUSAL_DRAFT_DECISIONS.pure_refusal;
  if (citations.grounded.length > 0) return REFUSAL_DRAFT_DECISIONS.hybrid_refusal;
  return REFUSAL_DRAFT_DECISIONS.asserting_refusal;
}
