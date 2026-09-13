import { describe, expect, it } from "vitest";
import {
  DISCLAIMER_MARKERS,
  MACHINE_TRANSLATION_LABEL,
  WARNING_MARKERS,
  parseInline,
  renderBodyBlocks,
  splitAnswerBlocks,
} from "./chat-render";
import type { AnswerInline } from "./chat-render";
import type { ChatCitation } from "@app/contracts";

const citation = (label: string): ChatCitation => ({
  label,
  arabic: "النص",
  machineTranslated: false,
});

/** Every character the render would show as plain text, including span interiors. */
const textOf = (inline: AnswerInline): string =>
  inline.kind === "text"
    ? inline.text
    : inline.kind === "bold" || inline.kind === "em"
      ? inline.children.map(textOf).join("")
      : "";

describe("parseInline", () => {
  it("turns a bracketed frame label into a chip and keeps the rest verbatim", () => {
    const segments = parseInline("Dalilnya [QS. 2:255] jelas.", [citation("QS. 2:255")]);
    expect(segments).toEqual([
      { kind: "text", text: "Dalilnya " },
      { kind: "citation", label: "QS. 2:255" },
      { kind: "text", text: " jelas." },
    ]);
  });

  it("falls back to the bare label when the model wrote no brackets", () => {
    const segments = parseInline("Dalilnya QS. 2:255 jelas.", [citation("QS. 2:255")]);
    expect(segments).toContainEqual({ kind: "citation", label: "QS. 2:255" });
  });

  it("never invents a chip: a frame label absent from the text renders nothing", () => {
    const segments = parseInline("Tanpa sitasi.", [citation("QS. 2:255")]);
    expect(segments).toEqual([{ kind: "text", text: "Tanpa sitasi." }]);
  });

  it("leaves non-citation brackets untouched ([Peringatan] is not a chip)", () => {
    const segments = parseInline("[Peringatan] waspada.", [citation("QS. 2:255")]);
    expect(segments).toEqual([{ kind: "text", text: "[Peringatan] waspada." }]);
  });

  it("locates multiple citations left-to-right; the leftmost wins overlaps", () => {
    const segments = parseInline("[QS. 112:1] dan [QS. 2:255].", [
      citation("QS. 2:255"),
      citation("QS. 112:1"),
    ]);
    expect(segments.filter((s) => s.kind === "citation").map((s) => s.label)).toEqual([
      "QS. 112:1",
      "QS. 2:255",
    ]);
  });

  // #150 — the grounded model still wraps spans in markdown; the card must
  // render them rich, never as literal asterisks.

  it("renders **QS. 2:255** as bold with the citation chip nested inside", () => {
    const segments = parseInline("**QS. 2:255**", [citation("QS. 2:255")]);
    expect(segments).toEqual([
      { kind: "bold", children: [{ kind: "citation", label: "QS. 2:255" }] },
    ]);
  });

  it("renders bold text as a bold span when no citation matches", () => {
    const segments = parseInline("**Ayat Kursi** adalah perlindungan.", []);
    expect(segments).toEqual([
      { kind: "bold", children: [{ kind: "text", text: "Ayat Kursi" }] },
      { kind: "text", text: " adalah perlindungan." },
    ]);
  });

  it("renders *emphasis* and _emphasis_ as em spans", () => {
    expect(parseInline("*ayat takhta*", [])).toEqual([
      { kind: "em", children: [{ kind: "text", text: "ayat takhta" }] },
    ]);
    expect(parseInline("_ayat takhta_", [])).toEqual([
      { kind: "em", children: [{ kind: "text", text: "ayat takhta" }] },
    ]);
  });

  it("renders ***bold italic*** as bold wrapping em (no leaked asterisk)", () => {
    expect(parseInline("***penting sekali***", [])).toEqual([
      {
        kind: "bold",
        children: [{ kind: "em", children: [{ kind: "text", text: "penting sekali" }] }],
      },
    ]);
    expect(parseInline("***QS. 2:255***", [citation("QS. 2:255")])).toEqual([
      {
        kind: "bold",
        children: [{ kind: "em", children: [{ kind: "citation", label: "QS. 2:255" }] }],
      },
    ]);
  });

  it("renders bold containing emphasis (**a *b* c**) without leaking its markers", () => {
    expect(parseInline("**kalam *masyhur* mazhab**", [])).toEqual([
      {
        kind: "bold",
        children: [
          { kind: "text", text: "kalam " },
          { kind: "em", children: [{ kind: "text", text: "masyhur" }] },
          { kind: "text", text: " mazhab" },
        ],
      },
    ]);
  });

  it("never leaves a literal marker on a well-formed span, including span interiors", () => {
    const text = "**QS. 2:255** dan ***penting sekali*** dalam *ayat takhta* / _surah_.";
    const segments = parseInline(text, [citation("QS. 2:255")]);
    const literals = segments.map(textOf).join("");
    expect(literals).not.toContain("*");
    expect(literals).not.toContain("_surah_");
  });

  it("keeps arithmetic and snake_case verbatim (no span around a space or word char)", () => {
    const text = "Hasil 2 * 3 * 4 = 24 dan nilai awal_x_akhir tetap.";
    expect(parseInline(text, [])).toEqual([{ kind: "text", text }]);
  });

  it("leaves an unclosed marker verbatim instead of guessing", () => {
    const text = "Jawaban **penting tanpa penutup.";
    expect(parseInline(text, [])).toEqual([{ kind: "text", text }]);
  });
});

describe("renderBodyBlocks", () => {
  it("groups consecutive bullet lines into one unordered list block", () => {
    const blocks = renderBodyBlocks(
      "- Allah Mahahidup\n- Penjaga segala sesuatu\n\nParagraf penutup.",
      [],
    );
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          [{ kind: "text", text: "Allah Mahahidup" }],
          [{ kind: "text", text: "Penjaga segala sesuatu" }],
        ],
      },
      { kind: "para", inlines: [{ kind: "text", text: "Paragraf penutup." }] },
    ]);
  });

  it("tells ordered from unordered bullets and groups each kind separately", () => {
    const blocks = renderBodyBlocks("1. Rukun pertama\n2) Rukun kedua\n- catatan", []);
    expect(
      blocks.map((b) => ({ kind: b.kind, ordered: b.kind === "list" ? b.ordered : null })),
    ).toEqual([
      { kind: "list", ordered: true },
      { kind: "list", ordered: false },
    ]);
  });

  it("keeps a citation chip and bold span working inside a list item", () => {
    const blocks = renderBodyBlocks("- **Allah** Mahahidup [QS. 2:255]", [citation("QS. 2:255")]);
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          [
            { kind: "bold", children: [{ kind: "text", text: "Allah" }] },
            { kind: "text", text: " Mahahidup " },
            { kind: "citation", label: "QS. 2:255" },
          ],
        ],
      },
    ]);
  });

  it("renders a marker-free body as a single paragraph, newlines preserved", () => {
    const body = "Baris pertama\nBaris kedua.";
    expect(renderBodyBlocks(body, [])).toEqual([
      { kind: "para", inlines: [{ kind: "text", text: body }] },
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
