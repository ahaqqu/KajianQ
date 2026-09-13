import { describe, expect, it } from "vitest";
import { REVIEWER_SYSTEM_PROMPT } from "./chat-reviewer";

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

  it("states the consequence so the verdict maps to the canonical refusal path", () => {
    expect(prompt).toContain("asserts nothing unsupported yet still FAILS");
    expect(prompt).toContain("the user receives the insufficiency refusal instead of an essay");
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
    expect(prompt).toContain("Using a term the QUESTION itself uses for a passage the evidence contains");
    expect(prompt).toContain("is not an unsupported claim");
  });

  it("still fixes the reply contract: ONLY JSON, pass|fail, with a reason", () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain('{"verdict": "pass" | "fail", "reason": "..."}');
    expect(REVIEWER_SYSTEM_PROMPT).toContain("reply with ONLY JSON");
  });
});
