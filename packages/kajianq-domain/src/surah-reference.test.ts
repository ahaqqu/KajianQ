import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SURAH_NAMES, normalizeSurahText, withoutArticle } from "./surah-names";
import { detectSurahReference } from "./surah-reference";

/**
 * Surah/verse-reference detection (ADR-0045).
 *
 * The invariant under test: a question that names a surah (by explicit
 * address or by name) is recognised deterministically, and a question that
 * does not name one is not. The second half is the trap — expansion is
 * additive context, so a false positive spends budget on an unrelated surah
 * and, worse, would let a question about the *person* Muhammad or the
 * *concept* ikhlas retrieve a surah neither asked about.
 *
 * Adversarial cases named before writing: article-less common names
 * (`Muhammad`, `Yunus`, `Maryam`), article-stripped ordinary words (`ikhlas`,
 * `qadr`, `asr`, `nas`, `tin`), out-of-range addresses, and an explicit
 * comparison naming two surahs (first reference wins).
 */

describe("the surah-name table", () => {
  it("covers all 114 surahs, numbered 1..114 in order, with unique names", () => {
    expect(SURAH_NAMES).toHaveLength(114);
    expect(SURAH_NAMES.map((s) => s.number)).toEqual(Array.from({ length: 114 }, (_, i) => i + 1));
    const normalized = SURAH_NAMES.map((s) => normalizeSurahText(s.name));
    for (const name of normalized) expect(name).not.toBe("");
    expect(new Set(normalized).size).toBe(114);
  });
});

describe("detectSurahReference — recognises a named reference", () => {
  it("detects the Golden Set gs-v0-015 question (the #142/#241 case)", () => {
    expect(
      detectSurahReference(
        "What does Surah Al-Fatihah mean and why is it recited in every prayer?",
      ),
    ).toEqual({ surah: 1 });
  });

  it("detects a name in both the canonical and the article-stripped form", () => {
    expect(detectSurahReference("What does Surah Al-Baqarah teach about fasting?")).toEqual({
      surah: 2,
    });
    expect(detectSurahReference("surat Fatihah artinya apa?")).toEqual({ surah: 1 });
    expect(detectSurahReference("jelaskan isi surah an-nas")).toEqual({ surah: 114 });
  });

  it("detects an explicit QS verse address", () => {
    expect(detectSurahReference("Apa makna QS. 2:255?")).toEqual({ surah: 2, ayah: 255 });
    expect(detectSurahReference("jelaskan Q.S. 112:1")).toEqual({ surah: 112, ayah: 1 });
    expect(detectSurahReference("tafsir QS 18:10")).toEqual({ surah: 18, ayah: 10 });
  });

  it("detects a surah-only QS address and the surah/surat marker", () => {
    expect(detectSurahReference("ringkas isi QS. 36")).toEqual({ surah: 36 });
    expect(detectSurahReference("apa isi surah 18?")).toEqual({ surah: 18 });
    expect(detectSurahReference("jelaskan surat ke-12")).toEqual({ surah: 12 });
  });

  it("detects an article-less name when the marker is present", () => {
    // Article-less names are ordinary proper nouns, so the marker is what
    // makes them a reference.
    expect(detectSurahReference("apa isi surah Muhammad?")).toEqual({ surah: 47 });
    expect(detectSurahReference("kisah surat Yunus")).toEqual({ surah: 10 });
    expect(detectSurahReference("surah ikhlas artinya apa?")).toEqual({ surah: 112 });
  });

  it("takes the first reference when a question names two surahs", () => {
    expect(
      detectSurahReference("What is the difference between Surah Al-Fatihah and Surah Al-Ikhlas?"),
    ).toEqual({ surah: 1 });
    // …and the numeric form orders by position too.
    expect(detectSurahReference("compare QS. 112:1 with Surah Al-Fatihah")).toEqual({
      surah: 112,
      ayah: 1,
    });
  });
});

describe("detectSurahReference — trap cases (no reference must be detected)", () => {
  it("ignores an article-less common name used about a person or place", () => {
    expect(
      detectSurahReference("Apa akhlak Nabi Muhammad shallallahu alaihi wasallam?"),
    ).toBeNull();
    expect(detectSurahReference("Siapa Maryam binti Imran?")).toBeNull();
  });

  it("ignores article-stripped ordinary words without the marker", () => {
    // `ikhlas` (sincerity), `qadr` (Lailatul Qadar), `asr` (the Asr prayer),
    // `nas` (people) are all ordinary Indonesian/Arabic words.
    expect(detectSurahReference("Apa makna ikhlas dalam beribadah?")).toBeNull();
    expect(detectSurahReference("Apa keutamaan malam Lailatul Qadar?")).toBeNull();
    expect(detectSurahReference("Bagaimana keutamaan sholat Asr?")).toBeNull();
  });

  it("ignores a bare surah name that is really a divine name (the gs-v0-012 trap)", () => {
    // The Golden Set question is about asmaul husna, not Surah Ar-Rahman.
    expect(detectSurahReference("Apa makna asmaul husna Ar-Rahman dan Ar-Rahim?")).toBeNull();
  });

  it("ignores questions about unrelated subjects", () => {
    expect(detectSurahReference("Bagaimana tata cara bersuci sebelum sholat?")).toBeNull();
    expect(
      detectSurahReference("What is the ruling on praying in a garment that contains gold?"),
    ).toBeNull();
    expect(detectSurahReference("")).toBeNull();
    expect(detectSurahReference("   ")).toBeNull();
  });

  it("rejects an out-of-range address instead of expanding a wrong surah", () => {
    expect(detectSurahReference("QS. 115:1")).toBeNull();
    expect(detectSurahReference("QS. 0:1")).toBeNull();
    expect(detectSurahReference("apa isi surah 999?")).toBeNull();
  });
});

describe("withoutArticle", () => {
  it("strips the transliterated definite article, longest prefix first", () => {
    expect(withoutArticle(normalizeSurahText("Ash-Shu'ara"))).toBe("shuara");
    expect(withoutArticle(normalizeSurahText("An-Nas"))).toBe("nas");
    expect(withoutArticle(normalizeSurahText("Quraish"))).toBe("quraish");
  });
});

/**
 * The whole Golden Set is the false-positive corpus: expansion is additive
 * context, so a question the detector wrongly flags spends budget on a surah
 * nobody asked about. This pins the exact set of questions that expand, so a
 * future name-table edit that starts matching an unrelated question fails
 * here rather than silently in the gate.
 */
describe("detectSurahReference over the Golden Set", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/golden-set-v0.json", import.meta.url), "utf8"),
  ) as { questions: { id: string; question: string }[] };

  it("flags exactly the questions that name a surah reference", () => {
    const flagged = fixture.questions
      .map((q) => [q.id, detectSurahReference(q.question)] as const)
      .filter(([, ref]) => ref !== null);
    expect(Object.fromEntries(flagged)).toEqual({
      "gs-v0-005": { surah: 112 },
      "gs-v0-009": { surah: 89, ayah: 28 },
      "gs-v0-014": { surah: 98, ayah: 5 },
      "gs-v0-015": { surah: 1 },
    });
  });
});
