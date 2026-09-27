import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOTAL_AYAHS, TOTAL_SURAHS } from "./quran-source";
import { SURAH_AYAH_COUNTS, SURAH_NAMES, normalizeSurahText, withoutArticle } from "./surah-names";
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

/**
 * The per-surah ayah counts are hand-maintained static domain data, so they
 * are pinned from both ends: the corpus total (a typo anywhere breaks the sum)
 * and the committed Tanzil surah-list fixture, whose four entries are exact.
 */
describe("the per-surah ayah counts", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/surah_list.json", import.meta.url), "utf8"),
  ) as Record<string, { id: number; count_ayat: number }>;

  it("has one count per surah, summing to the corpus total", () => {
    expect(SURAH_AYAH_COUNTS).toHaveLength(TOTAL_SURAHS);
    for (const count of SURAH_AYAH_COUNTS) expect(count).toBeGreaterThanOrEqual(1);
    expect(SURAH_AYAH_COUNTS.reduce((a, b) => a + b, 0)).toBe(TOTAL_AYAHS);
  });

  it("agrees with the committed Tanzil surah-list fixture", () => {
    for (const entry of Object.values(fixture)) {
      expect(SURAH_AYAH_COUNTS[entry.id - 1]).toBe(entry.count_ayat);
    }
  });

  it("pins the well-known counts a mixed-up table would break", () => {
    const count = (surah: number) => SURAH_AYAH_COUNTS[surah - 1];
    expect(count(1)).toBe(7); // Al-Fatihah
    expect(count(2)).toBe(286); // Al-Baqarah, the longest
    expect(count(36)).toBe(83); // Ya-Sin
    expect(count(55)).toBe(78); // Ar-Rahman
    expect(count(112)).toBe(4); // Al-Ikhlas
    expect(count(114)).toBe(6); // An-Nas
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

  it("keeps the verse only when the surah actually has it (A4)", () => {
    // `QS. 1:999` names surah 1 — the expansion reads that surah either way —
    // but Al-Fatihah has seven verses, so the trace must not claim verse 999.
    expect(detectSurahReference("makna QS. 1:999")).toEqual({ surah: 1 });
    expect(detectSurahReference("QS. 2:287")).toEqual({ surah: 2 });
    // The boundary verses themselves are real and stay exact.
    expect(detectSurahReference("QS. 1:7")).toEqual({ surah: 1, ayah: 7 });
    expect(detectSurahReference("QS. 2:286")).toEqual({ surah: 2, ayah: 286 });
    expect(detectSurahReference("QS. 114:6")).toEqual({ surah: 114, ayah: 6 });
    expect(detectSurahReference("QS. 114:7")).toEqual({ surah: 114 });
    // A worded verse carries no number in this grammar: honest surah-only
    // value rather than a guessed one.
    expect(detectSurahReference("surat al-baqarah ayat 255")).toEqual({ surah: 2 });
  });

  it("detects the one-word spellings of a two-word name under the marker (A3)", () => {
    // The executed gap: `surat yasin` / `surat thaha` / `surat yaa siin` hit
    // the very marker that makes them unambiguous and still missed, because
    // the table's canonical forms are two words (`ya sin`, `ta ha`).
    expect(detectSurahReference("kisah surat yasin")).toEqual({ surah: 36 });
    expect(detectSurahReference("surat thaha")).toEqual({ surah: 20 });
    expect(detectSurahReference("surat yaa siin")).toEqual({ surah: 36 });
    expect(detectSurahReference("surat ta ha")).toEqual({ surah: 20 });
    // The compact rule applies to every multi-word name, not just these two.
    expect(detectSurahReference("jelaskan surah annas")).toEqual({ surah: 114 });
    expect(detectSurahReference("isi surat alfatihah")).toEqual({ surah: 1 });
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

  it("ignores the one-word spellings when no marker precedes them (A3's guard)", () => {
    // The marker is what the new spellings trade on: `yasin` is a common
    // personal name and `annas` is `an-Nas` read as an ordinary word, so
    // without `surah`/`surat` they must stay invisible — exactly like every
    // other article-stripped form above.
    expect(detectSurahReference("Siapa Yasin dalam cerita itu?")).toBeNull();
    expect(detectSurahReference("Apa arti thaha menurut ulama?")).toBeNull();
    expect(detectSurahReference("Apa makna annas dalam bahasa Arab?")).toBeNull();
    // …and a one-word spelling no table rule reaches stays a recorded hole,
    // not a fuzzy match (ADR-0045 revisit trigger).
    expect(detectSurahReference("kisah surat yaseen")).toBeNull();
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

describe("detectSurahReference — the collapse's recorded false positive (R2)", () => {
  it("collapses a doubled-vowel ordinary word onto Al-Fil — accepted-as-is", () => {
    // The elongation collapse (A3) that makes `surat yaa siin` work also turns
    // `fiil` into `fil` — Al-Fil's article-stripped form — so a grammar phrase
    // like `surat fiil madhi` expands a surah the question never named. The
    // class is unreachable before the collapse step existed, realism is weak,
    // and the cost is bounded (a 5-verse surah), so ADR-0045's revisit triggers
    // record it and this test pins it rather than the collapse being narrowed —
    // narrowing would reopen the `yaa siin`/`annas` spellings A3 fixed.
    expect(normalizeSurahText("fiil")).toBe(normalizeSurahText("fil"));
    expect(detectSurahReference("surat fiil madhi")).toEqual({ surah: 105 });
    expect(detectSurahReference("surat fiil dalam bahasa arab")).toEqual({ surah: 105 });
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
