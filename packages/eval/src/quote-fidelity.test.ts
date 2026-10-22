import { describe, expect, it } from "vite-plus/test";
import {
  MIN_QUOTE_LENGTH,
  auditQuotes,
  normaliseQuote,
  quoteAppearsIn,
  quotedSpansIn,
} from "./quote-fidelity";

const CITED = [
  "Dirikanlah salat dan tunaikanlah zakat, dan rukuklah beserta orang-orang yang rukuk.",
  "Ia menuangkan air ke telapak tangannya lalu mencucinya, atau berkumur-kumur, lalu memasukkan air ke hidung dari satu cedukan telapak tangannya.",
];

describe("quoteAppearsIn", () => {
  it("accepts a verbatim span, ignoring case and punctuation", () => {
    expect(quoteAppearsIn("dirikanlah salat dan tunaikanlah zakat", CITED[0]!)).toBe(true);
  });

  it("accepts an elided span when the fragments appear in order", () => {
    expect(quoteAppearsIn("berkumur-kumur ... memasukkan air ke hidung", CITED[1]!)).toBe(true);
  });

  it("rejects a paraphrase that substitutes a term", () => {
    expect(quoteAppearsIn("berkumur-kumur dan beristinsyaq tiga kali", CITED[1]!)).toBe(false);
  });

  it("folds Arabic diacritics and orthographic variants", () => {
    expect(quoteAppearsIn("اقيموا الصلاة", "أقيموا الصلاة")).toBe(true);
  });

  it("folds Arabic punctuation and combining marks generically", () => {
    expect(quoteAppearsIn("إن الله وملائكته", "إن الله، وملائكته")).toBe(true);
    expect(quoteAppearsIn("الذين آمنوا", "ٱلَّذِينَ آمَنُوا")).toBe(true);
    expect(quoteAppearsIn("القرآن", "القر\u0653آن")).toBe(true);
  });

  it("rejects a span that begins inside a word", () => {
    expect(quoteAppearsIn("nyucikan harta", "menyucikan harta")).toBe(false);
  });

  it("rejects a span that ends inside a word", () => {
    expect(quoteAppearsIn("menyucikan hart", "menyucikan harta")).toBe(false);
  });

  it("applies caller-supplied equivalences after the generic fold", () => {
    const equivalences = [{ pattern: /\balpha\s+/gu, replacement: "alpha" }];
    expect(normaliseQuote("Alpha Beta", equivalences)).toBe(
      normaliseQuote("Alphabeta", equivalences),
    );
    expect(quoteAppearsIn("Alpha Beta", "Alphabeta", equivalences)).toBe(true);
  });
});

describe("quotedSpansIn", () => {
  it("does not pair a closing straight quote with the next opening one", () => {
    const spans = quotedSpansIn('Ia berkata "kalimat pertama" dan "kalimat kedua".');
    expect(spans).toEqual(["kalimat pertama", "kalimat kedua"]);
  });

  it("reads typographic and straight quotes in the same answer", () => {
    const spans = quotedSpansIn('Teks “kalimat pertama” lalu "kalimat kedua".');
    expect(spans).toEqual(["kalimat pertama", "kalimat kedua"]);
  });

  it("skips emphasis-length spans", () => {
    expect(quotedSpansIn('kata "ini" saja')).toEqual([]);
  });

  it("keeps a span at the minimum quotation length and skips a shorter one", () => {
    const atMinimum = "a".repeat(MIN_QUOTE_LENGTH);
    const below = "a".repeat(MIN_QUOTE_LENGTH - 1);
    expect(quotedSpansIn(`"${atMinimum}"`)).toEqual([atMinimum]);
    expect(quotedSpansIn(`"${below}"`)).toEqual([]);
  });

  it("keeps a span after an astral character instead of blanking the next opener", () => {
    const answer = '😊 “kutipan pertama yang panjang”"kutipan kedua yang panjang".';
    expect(quotedSpansIn(answer)).toEqual([
      "kutipan pertama yang panjang",
      "kutipan kedua yang panjang",
    ]);
  });

  it("drops an unterminated trailing segment instead of inventing a span", () => {
    const answer =
      'Ia berkata "kata pertama yang panjang" lalu "kata kedua yang panjang" dan dia menulis " tanda kutip di sini.';
    expect(quotedSpansIn(answer)).toEqual(["kata pertama yang panjang", "kata kedua yang panjang"]);
  });
});

describe("auditQuotes", () => {
  it("audits each span against the cited texts", () => {
    const answer =
      'Salat wajib: "Dirikanlah salat dan tunaikanlah zakat" (QS. 2:43). ' +
      'Wudhu: "berkumur-kumur, lalu memasukkan air ke hidung" (HR. Bukhari no. 191).';
    expect(auditQuotes(answer, CITED)).toEqual({ quoted: 2, verified: 2, unverifiable: [] });
  });

  it("reports a mixed fraction for one verified span of two", () => {
    const answer =
      'Salat: "Dirikanlah salat dan tunaikanlah zakat". ' +
      'Wudhu: "berkumur-kumur dan beristinsyaq".';
    const audit = auditQuotes(answer, CITED);
    expect(audit).toEqual({
      quoted: 2,
      verified: 1,
      unverifiable: ["berkumur-kumur dan beristinsyaq"],
    });
  });

  it("names the span that no cited chunk contains", () => {
    const answer = 'Wudhu: "berkumur-kumur dan beristinsyaq" (HR. Bukhari no. 191).';
    const audit = auditQuotes(answer, CITED);
    expect(audit.quoted).toBe(1);
    expect(audit.verified).toBe(0);
    expect(audit.unverifiable).toEqual(["berkumur-kumur dan beristinsyaq"]);
  });

  it("reports zero spans for an answer that quotes nothing", () => {
    expect(auditQuotes("Sumber tidak memuat jawabannya.", CITED)).toEqual({
      quoted: 0,
      verified: 0,
      unverifiable: [],
    });
  });

  it("reports zero spans when every quotation is below the threshold", () => {
    expect(auditQuotes('Kata "لا إله" saja.', CITED)).toEqual({
      quoted: 0,
      verified: 0,
      unverifiable: [],
    });
  });
});
