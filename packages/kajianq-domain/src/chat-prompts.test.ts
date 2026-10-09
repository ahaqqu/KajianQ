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

  it("forbids asserting links between evidence items the context does not state", () => {
    // Live smoke gs-v0-015: the reviewer failed a draft for claiming
    // "HR. Malik no. 185 corresponds to QS. 15:87" — a relationship neither
    // block states. An inferred link is an interpretation like any other.
    expect(chatSystemPrompt("id")).toMatch(/hubungan antar-bukti/);
    expect(chatSystemPrompt("en")).toMatch(/relationships between evidence items/);
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
  it("makes an absent specific item count as a missing answer, per language", () => {
    expect(chatSystemPrompt("id")).toMatch(/ayat, hadits, angka, tahun, atau nama tertentu/);
    expect(chatSystemPrompt("en")).toMatch(/a particular verse, hadith, number, year, or name/);
    // The loophole that gs-v0-019 exploited: the context says "no one knows".
    expect(chatSystemPrompt("id")).toMatch(/hanya menyatakan bahwa hal itu tidak diketahui/);
    expect(chatSystemPrompt("en")).toMatch(/only says that it is unknown/);
    // And it must still route to the exact sentence the detector matches.
    expect(chatSystemPrompt("id")).toContain(`"${DEFAULT_REFUSALS.id}"`);
    expect(chatSystemPrompt("en")).toContain(`"${DEFAULT_REFUSALS.en}"`);
  });

  it("guards the answer cases: present-subject questions must be answered", () => {
    // Without this guard the refusal condition swallowed gs-v0-015 ("what does
    // Surah Al-Fatihah mean…"), which is answerable from its evidence.
    expect(chatSystemPrompt("id")).toMatch(/WAJIB dijawab dari konteks/);
    expect(chatSystemPrompt("en")).toMatch(/MUST be answered from the context/);
  });
});

/**
 * **The authority order** (spec §2.2, per _kaidah usul_): Quran → Hadith
 * (mutawatir > sahih > hasan; dhaif flagged) → Tafsir → Kitab.
 *
 * It is enforced by the *system prompt*, while the *presentation* order
 * (Principles → Quran → Hadith → Kitab → concept links) is how the assembler
 * lays out the turn. The two orderings are deliberately distinct, and the
 * silent failure this suite guards against is their conflation: a prompt that
 * carried the presentation order would tell the model the lens *governs* the
 * evidence rather than framing it — a claim about authority the product does
 * not make — and the assembler's ordering would then look like a legal
 * ranking. So this asserts the authority sequence is present, in order, in
 * both languages, AND that the presentation order is not restated here as
 * authority.
 */
describe("the usul authority order", () => {
  // Each language names the sources in its own copy (the Indonesian text says
  // "Hadits", as the product's Indonesian copy does everywhere else).
  it.each([
    ["id", ["Quran", "Hadits", "Tafsir", "Kitab"]],
    ["en", ["Quran", "Hadith", "Tafsir", "Kitab"]],
  ] as const)("states the authority order in order (%s)", (language, sources) => {
    const rule = chatSystemPrompt(language)
      .split("\n")
      .find((line) => line.startsWith("8."));
    expect(rule).toBeDefined();
    // Every source of the authority order is named, and named in that order —
    // the sequence is the content, so its absence is the defect.
    const positions = sources.map((source) => rule!.indexOf(source));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it.each([["id"], ["en"]] as const)("carries the hadith grade precedence (%s)", (language) => {
    // mutawatir > sahih > hasan, with dhaif flagged: the grade order is part of
    // the authority rule, not a separate hint.
    const rule = chatSystemPrompt(language)
      .split("\n")
      .find((line) => line.startsWith("8."))!;
    const grades = ["mutawatir", "sahih", "hasan"].map((grade) => rule.indexOf(grade));
    for (const grade of grades) expect(grade).toBeGreaterThan(-1);
    expect(grades).toEqual([...grades].sort((a, b) => a - b));
    expect(rule).toMatch(/dhaif/i);
  });

  it("scopes the rule to the context so it cannot license outside knowledge", () => {
    // The authority order must never become a second source of evidence: rule 2
    // forbids any citation the context does not print, and rule 8 may only order
    // what is already there.
    expect(chatSystemPrompt("id")).toMatch(/Bila konteks memuat lebih dari satu jenis sumber/);
    expect(chatSystemPrompt("en")).toMatch(/When the context carries more than one kind of source/);
  });

  it("keeps the lens out of the authority order — the two orderings are distinct", () => {
    // The presentation order's first slot must NOT be the prompt's first
    // authority, and the prompt must not present the lens as governing
    // evidence; it frames the reading of it.
    expect(chatSystemPrompt("id")).toMatch(/bukan dalil yang berdiri sendiri/);
    expect(chatSystemPrompt("en")).toMatch(/not evidence standing on their own/);
  });
});
