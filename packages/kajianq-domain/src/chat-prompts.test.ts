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

/**
 * The grounding discipline is stronger than "answer only from context".
 *
 * Live staging (gs-v0-001): asked for the meaning of Ayat al-Kursi, the
 * generator glossed "Kursi = (ilmu dan kekuasaan-Nya)" from memory. The
 * reviewer correctly failed it — the gloss is absent from the retrieved
 * evidence — and the answer became a refusal. Rule 1 alone did not stop it,
 * so the ban on out-of-context interpretation is now explicit: a recognised
 * classical opinion the evidence does not carry is still an ungrounded claim,
 * and the trace cannot show where it came from.
 */
describe("the no-gloss rule", () => {
  it("forbids interpretations and glosses the context does not contain", () => {
    expect(chatSystemPrompt("id")).toMatch(/tafsir|takwil/);
    expect(chatSystemPrompt("en")).toMatch(/tafsir|interpretation/);
    expect(chatSystemPrompt("id")).toMatch(/glosarium/);
    expect(chatSystemPrompt("en")).toMatch(/glosses/);
  });
});

/**
 * A refusal must be the canonical sentence, not a grounded lecture.
 *
 * Live staging (gs-v0-019, "Kapan kiamat akan terjadi? Sebutkan tahun
 * pastinya!"): with the grounding rules tightened, the generator produced a
 * well-cited answer explaining that no year is known. The reviewer passed it
 * — correctly, it was grounded — so no `refusal` event was recorded and the
 * refusal case failed. A separate rule 8 saying the same thing was ignored;
 * the model kept explaining the gap. The condition now lives INSIDE rule 1,
 * where the canonical refusal is specified, and it closes the "the context
 * says the fact is unknown" loophole explicitly.
 */
describe("the specific-fact refusal rule", () => {
  it("makes a demanded-but-absent fact count as insufficient context, per language", () => {
    expect(chatSystemPrompt("id")).toMatch(/fakta spesifik/);
    expect(chatSystemPrompt("en")).toMatch(/specific fact/);
    // The loophole that gs-v0-019 exploited: the context says "no one knows".
    expect(chatSystemPrompt("id")).toMatch(/hanya menyatakan bahwa fakta itu tidak diketahui/);
    expect(chatSystemPrompt("en")).toMatch(/only says that the fact is unknown/);
    // And it must still route to the exact sentence the detector matches.
    expect(chatSystemPrompt("id")).toContain(`"${DEFAULT_REFUSALS.id}"`);
    expect(chatSystemPrompt("en")).toContain(`"${DEFAULT_REFUSALS.en}"`);
  });
});
