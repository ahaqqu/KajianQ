import { describe, expect, it } from "vitest";
import { REVIEWER_SYSTEM_PROMPT } from "./chat-reviewer";
import { validateCitations } from "./chat-citation-validator";
import { DEFAULT_REFUSALS, isEarnedRefusal } from "./chat-reviewer-prompt";

/**
 * The reviewer gate's fail criteria, pinned against the exact prompt string
 * production sends.
 *
 * Both failure directions are SILENT, which is why the pins matter:
 *
 * 1. Missing backstop (the gs-v0-019 Staging flake, c7e20a7, 2026-09-13): the
 *    generator disobeyed its rule 1 and produced a grounded, answer-form
 *    "no date is stated; only Allah knows" essay for a question demanding a
 *    specific fact. The draft asserted nothing unsupported, so the reviewer
 *    passed it, no `refusal` event was recorded, and `detectRefusal` scored the
 *    refusal-coverage trap as an answer. Removing or rewording away the
 *    "declines to answer" fail case re-opens the flake with no test failing.
 *
 * 2. Inflated refusals (SPECS §3.4 cost posture): the anti-over-fail
 *    guarantees — translating/quoting/citation labels are required behavior,
 *    and a term the QUESTION itself uses is not an unsupported claim — are what
 *    keep the gate from failing legitimate grounded answers (the gs-v0-015
 *    family of failures). Deleting or weakening them while editing the prompt
 *    would flip whole Golden Set runs to refusals, again with no test failing.
 *
 * So this file pins the new fail case, its narrowness, and the unchanged
 * protections — on the prompt itself, not a copy of it.
 */

/** The prompt is line-joined; phrase pins must survive the line wrapping. */
const prompt = REVIEWER_SYSTEM_PROMPT.replace(/\n/g, " ");

describe("the reviewer's decline-to-answer fail case", () => {
  it("adds 'declines to answer' to the Fail ONLY clause", () => {
    // The existing sentence must survive verbatim — this PR may not loosen it.
    expect(prompt).toContain(
      "Fail ONLY when the answer asserts something the evidence does not support, contradicts the evidence, cites a source absent from the evidence, or declines to answer.",
    );
  });

  it("scopes the new case to a demanded specific fact the evidence lacks", () => {
    expect(prompt).toContain(
      "the question demands one specific fact (a date, year, number, name, or a ruling on a specific case) the evidence does not contain",
    );
  });

  it("names the decline pattern: describing/explaining the evidence's silence instead of answering", () => {
    expect(prompt).toContain(
      "the draft instead describes, explains, or contextualizes what the evidence does or does not say about that fact",
    );
    // The exact shape that slipped through the c7e20a7 run, as an example.
    expect(prompt).toContain("no date is stated; only Allah knows");
  });

  it("states the consequence so the verdict maps to a refusal path", () => {
    expect(prompt).toContain("asserts nothing unsupported yet still FAILS");
    // The reviewer-fail path returns the reviewer-refusal copy
    // (`refusalTextFor(.., "reviewer")`), not the canonical insufficiency
    // string — the prompt must not promise copy the path does not deliver.
    expect(prompt).toContain("the user receives a refusal instead of an essay");
  });

  it("keeps the case narrow: partial answers and imprecise wording are not fails", () => {
    // Without this guard the new criterion would swallow legitimate answers
    // that only partly cover a broad question — the inflated-refusal direction.
    expect(prompt).toContain(
      "a draft that answers the question from what the evidence contains passes, and a partial answer or an imprecise wording is not a fail",
    );
  });
});

describe("the reviewer's anti-over-fail guarantees (unchanged)", () => {
  it("still makes translation, quoting, and citation labels required behavior, never a fail", () => {
    expect(prompt).toContain(
      "Translating a quoted passage into the answer's language, quoting it, and naming the citation labels the evidence itself carries are REQUIRED of the answer and are never grounds for failure",
    );
  });

  it("still exempts a term the question itself uses", () => {
    expect(prompt).toContain(
      "Using a term the QUESTION itself uses for a passage the evidence contains",
    );
    expect(prompt).toContain("is not an unsupported claim");
  });

  it("still fixes the reply contract: ONLY JSON, pass|fail, with a reason", () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain('{"verdict": "pass" | "fail", "reason": "..."}');
    expect(REVIEWER_SYSTEM_PROMPT).toContain("reply with ONLY JSON");
  });
});

/**
 * The EARNED refusal shape (#439): the decision the stage takes ON TOP of the
 * sentence predicate, and the reason it is a predicate of its own.
 *
 * `isRefusalDraft` is a substring match, so it also catches a HYBRID (the
 * sentence riding a grounded partial answer). Only a draft that cites NOTHING
 * ships verbatim — no rules, no invented warning for a text that cites no weak
 * evidence; a hybrid runs the rules the spec marks "Always". Every case below
 * feeds the REAL deterministic validator's partition to the decision, so the
 * pin is on the composition the stage uses, not on hand-built arrays.
 */
describe("the earned refusal shape (#439)", () => {
  const CHUNKS = [
    { id: "c1", text: "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ", metadata: { citation: "QS. 2:255" } },
  ] as never;
  const sentence = `Mohon maaf, kami ${DEFAULT_REFUSALS.id} untuk pertanyaan ini.`;

  it("is the sentence with no citation-shaped span, in either language", () => {
    expect(isEarnedRefusal(sentence, validateCitations(sentence, CHUNKS))).toBe(true);
    const en = `Sorry, we ${DEFAULT_REFUSALS.en} for this question.`;
    expect(isEarnedRefusal(en, validateCitations(en, CHUNKS))).toBe(true);
  });

  it("is NOT a hybrid: the same sentence riding a grounded span", () => {
    const hybrid = ["Allah Mahahidup dalam [QS. 2:255].", sentence].join("\n\n");
    const citations = validateCitations(hybrid, CHUNKS);
    expect(citations.grounded).toEqual(["QS. 2:255"]);
    expect(isEarnedRefusal(hybrid, citations)).toBe(false);
  });

  it("is NOT a draft whose only span the gate refused, even before that gate runs", () => {
    // The reorder-immunity case: `grounded.length === 0` alone would read this
    // as the earned shape and ship a refused citation verbatim, because the
    // span it does cite sits on the partition's OTHER side.
    const refused = ["Haditsnya [HR. Bukhari no. 99999].", sentence].join("\n\n");
    const citations = validateCitations(refused, CHUNKS);
    expect(citations.ungrounded).toEqual(["HR. Bukhari no. 99999"]);
    expect(citations.grounded).toEqual([]);
    expect(isEarnedRefusal(refused, citations)).toBe(false);
  });

  it("is NOT an ordinary answer that never carried the sentence", () => {
    const grounded = "Allah Mahahidup dalam [QS. 2:255].";
    expect(isEarnedRefusal(grounded, validateCitations(grounded, CHUNKS))).toBe(false);
  });
});
