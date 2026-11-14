import { describe, expect, it } from "vite-plus/test";
import type { SummarizerCase } from "@app/contracts";
import { ungroundedArabicTokens } from "./summarizer-bench-grounding";

/**
 * The summarizer bench's Arabic faithfulness read: a token may vary in
 * tashkeel or alef/ya spelling and still ground, because the fold that
 * compares it is the same one applied to the corpus; a token the corpus does
 * not carry is reported verbatim so the report names what the model invented.
 */

const CASE: SummarizerCase = {
  id: "sm-ar-01",
  kind: "surah",
  language: "ar",
  sourceKey: "corpus/source/112",
  title: "سُورَةُ الْاِخْلَاص",
  excerpt: ["قُلْ هُوَ اللّٰهُ اَحَدٌۚ", "اَللّٰهُ الصَّمَدُۚ"],
  expected: { minSentences: 1, maxSentences: 3 },
};

describe("ungroundedArabicTokens", () => {
  it("grounds a token written without its tashkeel in an excerpt that carries it", () => {
    expect(ungroundedArabicTokens(CASE, "Tema: احد.")).toEqual([]);
  });

  it("grounds an alef variant of the corpus spelling", () => {
    expect(ungroundedArabicTokens({ ...CASE, excerpt: ["أَحَدٌ"] }, "Tema: احد.")).toEqual([]);
  });

  it("reports a token the case does not carry, verbatim", () => {
    expect(ungroundedArabicTokens(CASE, "Menyebut كِتَابٌ حَكِيمٌ tanpa dasar.")).toEqual([
      'ungrounded Arabic token "كِتَابٌ"',
      'ungrounded Arabic token "حَكِيمٌ"',
    ]);
  });

  it("leaves non-Arabic text to the engine's other checks", () => {
    expect(ungroundedArabicTokens(CASE, "Surah ini menegaskan keesaan Allah.")).toEqual([]);
  });
});
