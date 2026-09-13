import { describe, expect, it } from "vitest";
import {
  DISCLAIMER_MARKERS,
  MACHINE_TRANSLATION_LABEL,
  WARNING_MARKERS,
  renderAnswerSegments,
  splitAnswerBlocks,
} from "./chat-render";
import type { ChatCitation } from "@app/contracts";

const citation = (label: string): ChatCitation => ({
  label,
  arabic: "النص",
  machineTranslated: false,
});

describe("renderAnswerSegments", () => {
  it("turns a bracketed frame label into a chip and keeps the rest verbatim", () => {
    const segments = renderAnswerSegments("Dalilnya [QS. 2:255] jelas.", [citation("QS. 2:255")]);
    expect(segments).toEqual([
      { kind: "text", text: "Dalilnya " },
      { kind: "citation", label: "QS. 2:255" },
      { kind: "text", text: " jelas." },
    ]);
  });

  it("falls back to the bare label when the model wrote no brackets", () => {
    const segments = renderAnswerSegments("Dalilnya QS. 2:255 jelas.", [citation("QS. 2:255")]);
    expect(segments).toContainEqual({ kind: "citation", label: "QS. 2:255" });
  });

  it("never invents a chip: a frame label absent from the text renders nothing", () => {
    const segments = renderAnswerSegments("Tanpa sitasi.", [citation("QS. 2:255")]);
    expect(segments).toEqual([{ kind: "text", text: "Tanpa sitasi." }]);
  });

  it("leaves non-citation brackets untouched ([Peringatan] is not a chip)", () => {
    const segments = renderAnswerSegments("[Peringatan] waspada.", [citation("QS. 2:255")]);
    expect(segments).toEqual([{ kind: "text", text: "[Peringatan] waspada." }]);
  });

  it("locates multiple citations left-to-right; the leftmost wins overlaps", () => {
    const segments = renderAnswerSegments("[QS. 112:1] dan [QS. 2:255].", [
      citation("QS. 2:255"),
      citation("QS. 112:1"),
    ]);
    expect(segments.filter((s) => s.kind === "citation").map((s) => s.label)).toEqual([
      "QS. 112:1",
      "QS. 2:255",
    ]);
  });
});

describe("splitAnswerBlocks", () => {
  it("peels the disclaimer into its own block (ID copy)", () => {
    const disclaimer = "Jawaban ini bukan fatwa; rujuk ulama untuk keputusan hukum.";
    const split = splitAnswerBlocks(`Jawaban singkat.\n\n${disclaimer}`);
    expect(split.body).toBe("Jawaban singkat.");
    expect(split.disclaimer).toBe(disclaimer);
    expect(split.warning).toBeNull();
  });

  it("peels warning then disclaimer (EN copy) in one pass", () => {
    const warning =
      "[Warning] The cited hadith is graded weak (dhaif); it may not be used as a primary proof.";
    const disclaimer = "This answer is not a fatwa; consult a scholar for legal rulings.";
    const split = splitAnswerBlocks(["Jawaban.", warning, disclaimer].join("\n\n"));
    expect(split.body).toBe("Jawaban.");
    expect(split.warning).toBe(warning);
    expect(split.disclaimer).toBe(disclaimer);
  });

  it("keeps an answer with no trailing rule paragraphs intact", () => {
    const split = splitAnswerBlocks("Jawaban pertama.\n\nJawaban kedua.");
    expect(split).toEqual({
      body: "Jawaban pertama.\n\nJawaban kedua.",
      warning: null,
      disclaimer: null,
    });
  });

  it("peels by marker prefix, so wording tweaks cannot hide the blocks", () => {
    const split = splitAnswerBlocks(
      "Jawaban.\n\n[Peringatan] Hadits yang dikutip berderajat lemah (dhaif); tidak dapat dijadikan dalil utama.",
    );
    expect(split.warning).toContain("[Peringatan]");
  });

  it("does not peel a long paragraph that merely mentions the phrase", () => {
    const prose = `${DISCLAIMER_MARKERS[0]} — dan ulasan panjang ${"x".repeat(300)}`;
    expect(splitAnswerBlocks(`Jawaban.\n\n${prose}`).disclaimer).toBeNull();
  });

  it("the MT label stays the language-invariant ADR-0006 constant", () => {
    expect(MACHINE_TRANSLATION_LABEL).toBe("Terjemahan mesin — lihat teks Arab asli");
    expect(WARNING_MARKERS).toEqual(["[Peringatan]", "[Warning]"]);
  });
});
