import { describe, expect, it } from "vite-plus/test";
import { auditQuotes, normaliseQuote, quoteAppearsIn, quotedSpansIn } from "./quote-fidelity";

const CITED = [
  {
    label: "QS. 2:43",
    text: "Dirikanlah salat dan tunaikanlah zakat, dan rukuklah beserta orang-orang yang rukuk.",
  },
  {
    label: "HR. Bukhari no. 191",
    text: "Ia menuangkan air ke telapak tangannya lalu mencucinya, atau berkumur-kumur, lalu memasukkan air ke hidung dari satu cedukan telapak tangannya.",
  },
];

describe("quoteAppearsIn", () => {
  it("accepts a verbatim span, ignoring case and punctuation", () => {
    expect(quoteAppearsIn("dirikanlah salat dan tunaikanlah zakat", CITED[0]!.text)).toBe(true);
  });

  it("accepts an elided span when the fragments appear in order", () => {
    expect(quoteAppearsIn("berkumur-kumur ... memasukkan air ke hidung", CITED[1]!.text)).toBe(
      true,
    );
  });

  it("rejects a paraphrase that substitutes a term", () => {
    expect(quoteAppearsIn("berkumur-kumur dan beristinsyaq tiga kali", CITED[1]!.text)).toBe(false);
  });

  it("folds Arabic diacritics and orthographic variants", () => {
    expect(quoteAppearsIn("اقيموا الصلاة", "أقيموا الصلاة")).toBe(true);
  });

  it("folds the space inside an Indonesian divine epithet", () => {
    expect(normaliseQuote("Maha Perkasa")).toBe(normaliseQuote("Mahaperkasa"));
  });
});

describe("quotedSpansIn", () => {
  it("does not pair a closing straight quote with the next opening one", () => {
    const spans = quotedSpansIn('Ia berkata "kalimat pertama" dan "kalimat kedua".');
    expect(spans.map((span) => span.quote)).toEqual(["kalimat pertama", "kalimat kedua"]);
  });

  it("reads typographic and straight quotes in the same answer", () => {
    const spans = quotedSpansIn('Teks “kalimat pertama” lalu "kalimat kedua".');
    expect(spans.map((span) => span.quote)).toEqual(["kalimat pertama", "kalimat kedua"]);
  });

  it("skips emphasis-length spans", () => {
    expect(quotedSpansIn('kata "ini" saja')).toEqual([]);
  });
});

describe("auditQuotes", () => {
  it("audits each span against the cited texts", () => {
    const answer =
      'Salat wajib: "Dirikanlah salat dan tunaikanlah zakat" (QS. 2:43). ' +
      'Wudhu: "berkumur-kumur, lalu memasukkan air ke hidung" (HR. Bukhari no. 191).';
    expect(auditQuotes(answer, CITED)).toEqual({ quoted: 2, verified: 2, unverifiable: [] });
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
});
