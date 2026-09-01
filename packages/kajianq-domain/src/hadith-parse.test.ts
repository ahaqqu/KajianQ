import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  alignEditions,
  assertHadithIntegrity,
  gradeConsolidationStats,
  parseHadithEdition,
} from "./hadith-parse";
import {
  HADITH_COLLECTIONS,
  formatHadithCitation,
  hadithMetadata,
  hadithPairId,
  hadithSourceKey,
  mapGrades,
  parseHadithCitation,
} from "./hadith-source";
import { buildHadithCorpus, corpusGradeStats } from "./hadith-ingest";

/**
 * Unit tests for the hadith domain model + parsers (#7). Fixtures are REAL
 * source slices (fawazahmed0/hadith-api, Sunan Abu Dawud book 1 "Purification"
 * — the slice deliberately spans every grade-mapping branch: all-Hasan,
 * Sahih-vs-Daif disagreement, all-Daif, all-Sahih, and Shadh-vs-Sahih).
 */

const FIXTURES = resolve(import.meta.dirname, "fixtures/hadith");

async function loadSlices() {
  const read = (f: string) => readFile(resolve(FIXTURES, f), "utf8");
  return {
    arabicText: await read("ara-abudawud-slice.json"),
    indonesianText: await read("ind-abudawud-slice.json"),
  };
}

describe("hadith grade consolidation (ADR-0025 dhaif-wins)", () => {
  it("maps every real grade class in the fixture: dhaif wins, hasan beats sahih", async () => {
    const { arabicText } = await loadSlices();
    const edition = parseHadithEdition("abudawud", "arabic", JSON.parse(arabicText));
    const gradesOf = (n: string) =>
      edition.hadiths.find((h) => h.hadithnumber === n)?.grades ?? [];
    // n=1: Hasan Sahih ×2 + Sahih Lighairihi + Isnaad Hasan → hasan (the
    // weaker class wins over plain Sahih).
    expect(mapGrades(gradesOf("1"))).toBe("hasan");
    // n=2: Sahih, Sahih, Sahih Lighairihi, Daif → dhaif wins (Albani vs Zai).
    expect(mapGrades(gradesOf("2"))).toBe("dhaif");
    // n=3: all Daif → dhaif.
    expect(mapGrades(gradesOf("3"))).toBe("dhaif");
    // n=4: all Sahih (incl. "Sahih Bukhari (142) Sahih Muslim (375)") → sahih.
    expect(mapGrades(gradesOf("4"))).toBe("sahih");
    // n=5: Shadh ×2 vs Isnaad Sahih → dhaif (Shadh is a defect class).
    expect(mapGrades(gradesOf("5"))).toBe("dhaif");
    // n=14, n=17: mixed Sahih/Daif → dhaif.
    expect(mapGrades(gradesOf("14"))).toBe("dhaif");
    expect(mapGrades(gradesOf("17"))).toBe("dhaif");
  });

  it("maps the weak-grade vocabulary and never fabricates a grade", () => {
    expect(mapGrades([{ name: "X", grade: "Munkar" }])).toBe("dhaif");
    expect(mapGrades([{ name: "X", grade: "Very Daif" }])).toBe("dhaif");
    expect(mapGrades([{ name: "X", grade: "Sahih Muslim" }])).toBe("sahih");
    expect(mapGrades([{ name: "X", grade: "Isnaad Hasan" }])).toBe("hasan");
    expect(mapGrades([])).toBeNull();
    expect(mapGrades([{ name: "X", grade: "Mash-hoor" }])).toBeNull();
    // mutawatir is never self-asserted from this source's vocabulary.
    for (const grade of ["Sahih", "Hasan", "Daif", "Munkar", "Shadh"]) {
      expect(mapGrades([{ name: "X", grade }])).not.toBe("mutawatir");
    }
  });

  it("summarizes consolidation stats over a record set", () => {
    const records = [
      { collection: "abudawud", hadithNo: "1", bookNo: 1, bookName: null, textAr: "a", textId: null, grades: [{ name: "A", grade: "Sahih" }] },
      { collection: "abudawud", hadithNo: "2", bookNo: 1, bookName: null, textAr: "b", textId: null, grades: [{ name: "A", grade: "Daif" }] },
      { collection: "abudawud", hadithNo: "3", bookNo: 1, bookName: null, textAr: "c", textId: null, grades: [] },
    ] as const;
    expect(gradeConsolidationStats(records)).toEqual({ graded: 2, dhaifWins: 1, ungraded: 1 });
  });
});

describe("hadith citation format (CONTEXT.md: HR. Bukhari no. 573 (Sahih))", () => {
  it("formats with and without grade", () => {
    expect(
      formatHadithCitation({ collection: "bukhari", hadithNo: "573", grade: "sahih" }),
    ).toBe("HR. Bukhari no. 573 (Sahih)");
    expect(formatHadithCitation({ collection: "muslim", hadithNo: "12" })).toBe(
      "HR. Muslim no. 12",
    );
  });

  it("round-trips parse(format(label))", () => {
    const label = "HR. Bukhari no. 573 (Sahih)";
    const parsed = parseHadithCitation(label);
    expect(parsed).toEqual({
      sourceType: "hadith",
      collection: "bukhari",
      hadithNo: "573",
      grade: "sahih",
    });
    if (parsed === null) throw new Error("parse failed");
    expect(formatHadithCitation(parsed)).toBe(label);
    expect(parseHadithCitation("QS. 2:255")).toBeNull();
    expect(parseHadithCitation("HR. Unknown no. 1")).toBeNull();
  });

  it("writes filterable child metadata", () => {
    const meta = hadithMetadata({
      collection: "abudawud",
      hadithNo: "4",
      bookNo: 1,
      bookName: "Purification",
      textAr: "a",
      textId: "t",
      grades: [{ name: "Al-Albani", grade: "Sahih" }],
    });
    expect(meta.sourceType).toBe("hadith");
    expect(meta.collection).toBe("abudawud");
    expect(meta.hadithNo).toBe("4");
    expect(meta.grade).toBe("sahih");
    expect(meta.citation).toBe("HR. Abu Dawud no. 4 (Sahih)");
    expect((meta.grades as unknown[]).length).toBe(1);
  });

  it("builds stable provenance keys", () => {
    expect(hadithSourceKey("abudawud", 1)).toBe("hadith/abudawud/section/1");
    expect(hadithPairId("abudawud", "4")).toBe("hadith-pair:abudawud:4");
  });
});

describe("hadith edition parsing + alignment (real fixture slices)", () => {
  it("parses both editions with sections intact", async () => {
    const { arabicText, indonesianText } = await loadSlices();
    const arabic = parseHadithEdition("abudawud", "arabic", JSON.parse(arabicText));
    const indonesian = parseHadithEdition("abudawud", "indonesian", JSON.parse(indonesianText));
    expect(arabic.hadiths).toHaveLength(7);
    expect(arabic.sections.get(1)).toBe("Purification (Kitab Al-Taharah)");
    expect(indonesian.hadiths).toHaveLength(7);
  });

  it("throws on shape drift", async () => {
    // parseHadithEdition is sync-throwing; wrap to assert the message.
    expect(() => parseHadithEdition("abudawud", "arabic", { metadata: null, hadiths: [] })).toThrow(
      /no metadata/,
    );
    expect(() => parseHadithEdition("abudawud", "arabic", { metadata: {}, hadiths: "nope" })).toThrow(
      /hadiths array/,
    );
    expect(() =>
      parseHadithEdition("abudawud", "arabic", {
        metadata: {},
        hadiths: [{ hadithnumber: 1 }],
      }),
    ).toThrow(/missing required fields/);
  });

  it("aligns ara/ind on (book, arabicnumber) and reports empty secondary", async () => {
    const { arabicText, indonesianText } = await loadSlices();
    const arabic = parseHadithEdition("abudawud", "arabic", JSON.parse(arabicText));
    const indonesian = parseHadithEdition("abudawud", "indonesian", JSON.parse(indonesianText));
    const { records, stats } = alignEditions(arabic, indonesian);
    // The slice carries two empty-Indonesian entries (3 zeroed for the test,
    // 5 genuinely empty in the source — a real Shadh narration quirk) —
    // tolerated as textId: null, surfaced in stats, never fabricated.
    expect(records).toHaveLength(7);
    expect(stats.aligned).toBe(5);
    expect(stats.emptySecondary).toBe(2);
    expect(stats.unmatched).toHaveLength(0);
    const no3 = records.find((r) => r.hadithNo === "3");
    expect(no3?.textId).toBeNull();
    expect(no3?.textAr.trim().length).toBeGreaterThan(0);
    const no5 = records.find((r) => r.hadithNo === "5");
    expect(no5?.textId).toBeNull();
  });

  it("quarantines unmatched entries instead of force-merging", async () => {
    const { arabicText } = await loadSlices();
    const arabic = parseHadithEdition("abudawud", "arabic", JSON.parse(arabicText));
    // An Indonesian edition missing hadith 17 leaves an unmatched ara entry.
    const indonesian = parseHadithEdition("abudawud", "indonesian", {
      metadata: { sections: { "1": "Purification" }, section_details: {} },
      hadiths: arabic.hadiths.filter((h) => h.hadithnumber !== "17").map((h) => ({
        ...h,
        text: "terjemahan",
        grades: [],
      })),
    });
    const { records, stats } = alignEditions(arabic, indonesian);
    expect(records).toHaveLength(6);
    expect(stats.unmatched).toEqual([
      { collection: "abudawud", key: "1:17", side: "indonesian" },
    ]);
  });

  it("asserts integrity: empty arabic, duplicates, count gates", async () => {
    const { arabicText, indonesianText } = await loadSlices();
    const arabic = parseHadithEdition("abudawud", "arabic", JSON.parse(arabicText));
    const indonesian = parseHadithEdition("abudawud", "indonesian", JSON.parse(indonesianText));
    const { records } = alignEditions(arabic, indonesian);
    expect(() => assertHadithIntegrity(records, { abudawud: 7 })).not.toThrow();
    expect(() => assertHadithIntegrity(records, { abudawud: 6 })).toThrow(/expected 6/);
    expect(() =>
      assertHadithIntegrity([...records, { ...records[0]! }], undefined),
    ).toThrow(/duplicate/);
    const bad = records.map((r, i) => (i === 0 ? { ...r, textAr: "  " } : r));
    expect(() => assertHadithIntegrity(bad, undefined)).toThrow(/no Arabic text/);
  });
});

describe("hadith corpus build", () => {
  it("builds with per-collection gates and grade stats", async () => {
    const { arabicText, indonesianText } = await loadSlices();
    const corpus = buildHadithCorpus(
      {
        arabic: { abudawud: JSON.parse(arabicText) },
        indonesian: { abudawud: JSON.parse(indonesianText) },
      },
      { abudawud: 7 },
    );
    expect(corpus.records).toHaveLength(7);
    const stats = corpusGradeStats(corpus);
    // Every record in the slice is graded; the dhaif-wins demotions are the
    // real disagreement entries (2, 3, 5, 14, 17).
    expect(stats.graded).toBe(7);
    expect(stats.dhaifWins).toBe(5);
    expect(stats.ungraded).toBe(0);
  });

  it("throws when a collection has no Indonesian edition", async () => {
    const { arabicText } = await loadSlices();
    expect(() =>
      buildHadithCorpus({ arabic: { abudawud: JSON.parse(arabicText) }, indonesian: {} }),
    ).toThrow(/no Indonesian edition/);
  });

  it("registers exactly the seven v1 collections", () => {
    expect(HADITH_COLLECTIONS).toHaveLength(7);
    expect([...HADITH_COLLECTIONS]).toEqual([
      "bukhari",
      "muslim",
      "abudawud",
      "tirmidhi",
      "nasai",
      "ibnmajah",
      "malik",
    ]);
  });
});