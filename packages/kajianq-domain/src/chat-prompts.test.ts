import { describe, expect, it } from "vitest";
import { chatSystemPrompt } from "./chat-prompts";
import { DEFAULT_REFUSALS } from "./chat-reviewer";

/**
 * The refusal contract between the generator and the detector.
 *
 * The refusal detector (and therefore the eval harness's refusal marker check)
 * decides "did the model refuse?" by looking for the canonical refusal string on
 * the answer. A model that refuses in its own words — "tidak ada satu pun hadits
 * yang disebutkan dalam konteks…" — is scored as having ANSWERED, which is how the
 * fabricated-attribution trap failed its first live run even though the stored
 * answer refused correctly.
 *
 * `chat-prompts` therefore interpolates the very constant the detector matches
 * (`DEFAULT_REFUSALS`) instead of restating it, and the rule is an exact-output
 * instruction rather than advice. These tests pin both halves.
 */
describe("the canonical refusal contract", () => {
  it("tells the generator to emit the exact sentence the detector matches, per language", () => {
    expect(chatSystemPrompt("id")).toContain(`"${DEFAULT_REFUSALS.id}"`);
    expect(chatSystemPrompt("en")).toContain(`"${DEFAULT_REFUSALS.en}"`);
    // The wording that makes it a contract rather than a suggestion.
    expect(chatSystemPrompt("id")).toMatch(/PERSIS/);
    expect(chatSystemPrompt("en")).toMatch(/EXACTLY/);
  });

  it("no longer leaves the insufficiency rule as free-form advice", () => {
    // The regression itself: the old rule said "say plainly that you could not
    // find adequate evidence", which the generator paraphrased.
    expect(chatSystemPrompt("id")).not.toMatch(/katakan terus terang/);
    expect(chatSystemPrompt("en")).not.toMatch(/say plainly/);
  });
});
