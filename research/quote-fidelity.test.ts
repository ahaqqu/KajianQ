import { describe, expect, it } from "bun:test";
import { checkAnswer, normalise, quoteIsFaithful } from "./quote-fidelity";

const HADITH =
  "Telah menceritakan kepada kami [Malik] dari [Nafi] dari [Ibnu Umar] bahwa Rasulullah " +
  "shallallahu 'alaihi wasallam bila tergesa-gesa dalam perjalanan beliau menjama' shalat " +
  "Maghrib dan Isya.";

const ARABIC = "وَلَيْسَ كَمِثْلِهِ شَيْءٌ وَهُوَ السَّمِيعُ الْبَصِيرُ";

describe("normalise", () => {
  it("folds diacritics and orthographic variants", () => {
    expect(normalise("السَّمِيعُ")).toBe(normalise("السميع"));
    expect(normalise("أحمد")).toBe(normalise("احمد"));
    expect(normalise("Riba   DIHARAMKAN,")).toBe("riba diharamkan");
  });
});

describe("quoteIsFaithful", () => {
  it("accepts a verbatim span", () => {
    expect(quoteIsFaithful("beliau menjama' shalat Maghrib dan Isya", HADITH)).toBe(true);
  });

  it("accepts an elided span when the fragments appear in order", () => {
    expect(quoteIsFaithful("Telah menceritakan ... menjama' shalat Maghrib", HADITH)).toBe(true);
  });

  it("accepts Arabic with the diacritics stripped", () => {
    expect(quoteIsFaithful("وليس كمثله شيء", ARABIC)).toBe(true);
  });

  it("rejects a paraphrase", () => {
    expect(quoteIsFaithful("Isya dan Maghrib beliau menjama' shalat", HADITH)).toBe(false);
  });

  it("rejects a span lifted from another chunk", () => {
    expect(quoteIsFaithful("Barangsiapa membaca satu huruf", HADITH)).toBe(false);
  });

  it("rejects an empty quote", () => {
    expect(quoteIsFaithful("   ", HADITH)).toBe(false);
  });
});

describe("checkAnswer", () => {
  const citations = [
    { label: "HR. Malik no. 326", text: HADITH },
    { label: "QS. 42:11", text: "Tidak ada sesuatu pun yang serupa dengan-Nya." },
  ];

  it("binds a quote to the chunk that contains it", () => {
    const answer =
      "Beliau menjama' shalat saat safar, \"beliau menjama' shalat Maghrib dan Isya\".";
    expect(checkAnswer(answer, citations)).toEqual([
      {
        quote: "beliau menjama' shalat Maghrib dan Isya",
        status: "faithful",
        citation: "HR. Malik no. 326",
      },
    ]);
  });

  it("marks a quote that appears in no cited chunk as unverifiable", () => {
    const answer = 'Ia berkata, "Barangsiapa membaca satu huruf dari Al-Quran".';
    expect(checkAnswer(answer, citations)).toEqual([
      {
        quote: "Barangsiapa membaca satu huruf dari Al-Quran",
        status: "unverifiable",
        reason: "no-quote-in-citation",
      },
    ]);
  });

  it("distinguishes an answer that cites nothing", () => {
    const answer = 'Ia berkata, "Barangsiapa membaca satu huruf dari Al-Quran".';
    expect(checkAnswer(answer, [])).toEqual([
      {
        quote: "Barangsiapa membaca satu huruf dari Al-Quran",
        status: "unverifiable",
        reason: "no-citations",
      },
    ]);
  });
});
