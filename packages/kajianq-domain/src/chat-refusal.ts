import type { ChatLanguage } from "./chat-prompts";

/**
 * The refusal vocabulary — one owner for the canonical insufficiency sentence,
 * the pinned floors around it, the predicates that read a draft for it, the
 * decision table and the trace vocabulary that decision records.
 *
 * Split out of `chat-reviewer-prompt.ts` (round B1 of the #443 review) when
 * that module reached 298 of the 300-line agentic cap; it re-exports these
 * names so the stage keeps its one import (the stage sits at the 5-import cap).
 */

/**
 * The default refusal language (the generator's ID/EN insufficiency text).
 * `chat-prompts.ts` imports this to instruct the generator to emit it verbatim —
 * the detector matches these exact strings, so copy and instruction cannot drift.
 */
export const DEFAULT_REFUSALS = {
  id: "tidak menemukan dalil yang memadai",
  en: "could not find adequate evidence",
} as const;

/**
 * The two pinned refusal FLOORS (#285): the product's own frame around the
 * canonical sentence, one per language, split where the sentence sits. They own
 * the frame the exemption below reads and the floor copy the tests render, so a
 * copy edit moves rule and pins together instead of the exemption silently.
 */
export const REFUSAL_FLOORS = {
  id: { head: "Mohon maaf, kami", tail: "untuk pertanyaan ini" },
  en: { head: "Sorry, we", tail: "for this question" },
} as const;

/** The pinned floor text: a language's frame wrapped around its canonical sentence. */
export function refusalFloorText(language: ChatLanguage): string {
  const { head, tail } = REFUSAL_FLOORS[language];
  return `${head} ${DEFAULT_REFUSALS[language]} ${tail}.`;
}

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
 * in either language (a substring match; `chat-prompts.ts` instructs the
 * generator to emit it verbatim — the model may answer in the wrong language,
 * and a refusal in either is still a refusal).
 *
 * It is deliberately NOT "this text is a refusal": the same sentence is the
 * tail of a HYBRID draft — a grounded partial answer that runs into it (#436,
 * #439) — and the head of an ASSERTING refusal draft whose own text asserts
 * something and cites nothing (#443). `refusalDraftDecision` owns what each
 * shape earns: all three skip the paid reviewer, but only the declining shape
 * ships as written, because the rules the spec marks "Always" are computed for
 * whatever text actually ships. Narrowing this moves that boundary silently:
 * the hybrid half is pinned by `chat-reviewer-evidence.test.ts` and
 * `chat-dhaif-warning.test.ts`, the asserting half by `chat-refusal.test.ts`.
 */
export function isRefusalDraft(text: string): boolean {
  const t = text.toLowerCase();
  return CANONICAL_SENTENCES.some((sentence) => t.includes(sentence));
}

/**
 * What ends a sentence for the refusal-only shape test: terminal punctuation in
 * either script (`[.!?؟۔]+`), a blank line and a list item's own line. An
 * intra-paragraph line WRAP is not a boundary, so the pinned wrapped floor
 * (`"Mohon maaf,\nkami …\nuntuk pertanyaan ini."`) stays one sentence. Reading
 * every newline as a boundary once let an unterminated assertion, a list body
 * and an Arabic line keep the exemption (review A1 of #443).
 */
const SENTENCE_BOUNDARIES = /[.!?؟۔]+|\r?\n[ \t]*\r?\n|^[ \t]*(?:[-*•]|\d+[.)])[ \t]+/mu;

/**
 * The residues a segment may carry, from `REFUSAL_FLOORS` (so the rule cannot
 * drift from the floors it reads): a leading or trailing whole-word run of a
 * floor's head or tail, or the frame entire (`"Mohon maaf."` and `"kami …"` are
 * one floor's frame split by a sentence boundary). Ordered runs, not word
 * membership: `"We question this."` uses only the frame's own words and still
 * asserts — the shape review A1 of #452 measured shipping verbatim.
 */
const FRAME_RESIDUES = new Set(
  Object.values(REFUSAL_FLOORS).flatMap(({ head, tail }) => [
    ...frameRuns(head),
    ...frameRuns(tail),
    `${normaliseFrame(head)} ${normaliseFrame(tail)}`,
  ]),
);

/** A frame part or a segment residue, read the one way: folded, separators spaced. */
function normaliseFrame(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:،؟۔]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every leading and trailing whole-word run of one floor part. */
function frameRuns(part: string): string[] {
  const words = normaliseFrame(part).split(" ");
  return words.flatMap((_, at) => [words.slice(0, at + 1).join(" "), words.slice(at).join(" ")]);
}

/**
 * True when one sentence of the draft carries nothing but the canonical
 * sentence and its frame: every canonical occurrence is stripped, and the
 * residue must be one of the floors' own ordered runs. An empty residue passes
 * only when the segment itself carried a canonical occurrence — a symbol-only
 * segment (`"—"`, `"🤲🤲"`) leaves no words either, and neither is the
 * product's frame (review A2 of #452).
 */
function isRefusalSegment(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  const carried = CANONICAL_SENTENCES.some((canonical) => lower.includes(canonical));
  const residue = CANONICAL_SENTENCES.reduce(
    (text, canonical) => text.split(canonical).join(" "),
    lower,
  );
  const normalised = normaliseFrame(residue);
  return normalised === "" ? carried : FRAME_RESIDUES.has(normalised);
}

/**
 * True when the draft is the refusal and NOTHING else (#443, #452): it carries
 * the canonical sentence, and every segment beside it is the floor's own frame
 * read in the floor's order — never a claim of the model's. This is the
 * DETERMINISTIC signal the earned-refusal exemption was missing: the decline
 * backstop, symmetric to the reviewer's "declines to answer" case, and the
 * reason a citation-free draft that asserts can no longer pass as a decline.
 *
 * It is a SHAPE test, deliberately not a claim classifier: anything it does not
 * recognise takes the refusal backstop — the product's own refusal, never worse
 * than an assertion nobody vouches for (SPECS §1.5 boundary 2), while decorating
 * an assertion leaves it standing (SPECS §2.2). An assertion inside the
 * refusal's OWN sentence is the floor's own shape, so only the frame's own
 * ordered words separate the claim (`haditsnya`, `sahih`, `namun`) from the
 * frame (#452); both directions are pinned in `chat-refusal.test.ts`.
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
 * draft's spans (`chat-citation-validator.ts`), so both lists empty is the
 * positive reading of "this draft cites nothing" and `isRefusalOnly` of "this
 * draft declines"; reading `grounded` alone would mean the weaker "no grounded
 * span", which is why `refusalDraftDecision` reads the ungrounded half first.
 *
 * The classification may skip the PAID reviewer (ADR-0009); it may not skip a
 * rule the spec makes `Always` (SPECS §2.2), which is why a HYBRID — the
 * sentence riding an answer that cites something — funnels through the stage's
 * `withRules` instead, nor the reader's ability to tell a refusal from prose
 * (#443), which is why the shape that cites nothing but asserts ships the
 * product's own refusal. The shape vocabulary is normative in `CONTEXT.md`.
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
 * The `refusal` event's machine-readable trigger vocabulary, one home for all
 * four (round A2 of the #443 review). `generator_refusal` covers both
 * sentence-carrying shapes that return the draft; every other trigger REPLACES
 * the delivered text with product copy — the invariant `traceRefused` in
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
   * (`product_refusal` — the caller supplies its copy). Every row records its
   * event; no delivery is "record nothing".
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
