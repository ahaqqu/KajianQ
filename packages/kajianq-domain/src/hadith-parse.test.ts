import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  alignEditions,
  assertHadithIntegrity,
  parseHadithEdition,
} from "./hadith-parse";
import { gradeConsolidationStats } from "./hadith-ingest";
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
    expect(mapGrades([{ name: "X", grade: "Sanad Daif" }])).toBe("dhaif");
    // Real weak classes that previously fell through (review A3).
    expect(mapGrades([{ name: "X", grade: "Mawdu" }])).toBe("dhaif");
    expect(mapGrades([{ name: "X", grade: "Batil" }])).toBe("dhaif");
    expect(mapGrades([{ name: "X", grade: "Sahih Isnaad Mursal" }])).toBe("dhaif");
    // Mawdu beats a grader's Hasan (review A3: ibnmajah:2736).
    expect(
      mapGrades([
        { name: "X", grade: "Mawdu" },
        { name: "Y", grade: "Hasan" },
      ]),
    ).toBe("dhaif");
    expect(mapGrades([{ name: "X", grade: "Sahih Muslim" }])).toBe("sahih");
    expect(mapGrades([{ name: "X", grade: "Isnaad Hasan" }])).toBe("hasan");
    // Attribution-scope classes combine with positive grades and are NOT
    // defects ("Mauquf Sahih" is graded sahih-as-mauquf in the source).
    expect(mapGrades([{ name: "X", grade: "Mauquf Sahih" }])).toBe("sahih");
    expect(mapGrades([{ name: "X", grade: "Maqtu Daif" }])).toBe("dhaif");
    // Bare Maqtu/Mauquf carry no class at all — null, never fabricated.
    expect(mapGrades([{ name: "X", grade: "Maqtu" }])).toBeNull();
    // Marfoo is an elevated chain, not a defect (review A3) — no longer weak.
    expect(mapGrades([{ name: "X", grade: "Marfoo" }])).toBeNull();
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

  it("round-trips every registered collection, including multi-word names (review A4)", () => {
    for (const collection of HADITH_COLLECTIONS) {
      const label = formatHadithCitation({ collection, hadithNo: "12" });
      const parsed = parseHadithCitation(label);
      expect(parsed).not.toBeNull();
      expect(parsed?.collection).toBe(collection);
      expect(parsed?.hadithNo).toBe("12");
      // Round-trip with the grade suffix too.
      const graded = formatHadithCitation({ collection, hadithNo: "12", grade: "sahih" });
      expect(parseHadithCitation(graded)?.grade).toBe("sahih");
    }
    // The two multi-word display names explicitly (previously returned null).
    expect(parseHadithCitation("HR. Abu Dawud no. 4 (Sahih)")).toEqual({
      sourceType: "hadith",
      collection: "abudawud",
      hadithNo: "4",
      grade: "sahih",
    });
    expect(parseHadithCitation("HR. Ibn Majah no. 12")).toEqual({
      sourceType: "hadith",
      collection: "ibnmajah",
      hadithNo: "12",
    });
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
    // The slice's hadith 5 is GENUINELY empty in the source (a real Shadh
    // narration quirk) — tolerated as textId: null, surfaced in stats,
    // never fabricated.
    expect(records).toHaveLength(7);
    expect(stats.aligned).toBe(6);
    expect(stats.emptySecondary).toBe(1);
    expect(stats.unmatched).toHaveLength(0);
    const no5 = records.find((r) => r.hadithNo === "5");
    expect(no5?.textId).toBeNull();
    expect(no5?.textAr.trim().length).toBeGreaterThan(0);
  });

  it("accepts the source's numeric hadithnumber/arabicnumber (review A1)", async () => {
    // The fixture is byte-true: the source ships JSON numbers, not strings.
    const raw = JSON.parse(await readFile(resolve(FIXTURES, "ara-abudawud-slice.json"), "utf8")) as {
      hadiths: { hadithnumber: number | string }[];
    };
    expect(typeof raw.hadiths[0]!.hadithnumber).toBe("number");
    const edition = parseHadithEdition("abudawud", "arabic", raw);
    expect(edition.hadiths[0]!.hadithnumber).toBe("1");
    expect(edition.hadiths[0]!.arabicnumber).toBe("1");
    // muslim's book-0 rows lack arabicnumber entirely — falls back to the
    // edition's own hadithnumber (the alignment's fallback join key).
    const edition2 = parseHadithEdition("muslim", "arabic", {
      metadata: {},
      hadiths: [{ hadithnumber: 3, text: "matn", grades: [], reference: { book: 0, hadith: 3 } }],
    });
    expect(edition2.hadiths[0]).toMatchObject({ hadithnumber: "3", arabicnumber: "3" });
  });

  it("throws on a malformed grade entry instead of dropping it (review B4)", () => {
    expect(() =>
      parseHadithEdition("abudawud", "arabic", {
        metadata: {},
        hadiths: [
          {
            hadithnumber: 1,
            arabicnumber: 1,
            text: "matn",
            grades: [{ name: "Al-Albani" }],
            reference: { book: 1, hadith: 1 },
          },
        ],
      }),
    ).toThrow(/malformed grade entry/);
    expect(() =>
      parseHadithEdition("abudawud", "arabic", {
        metadata: {},
        hadiths: [
          {
            hadithnumber: 1,
            arabicnumber: 1,
            text: "matn",
            grades: [{ name: "X", grade: 5 }],
            reference: { book: 1, hadith: 1 },
          },
        ],
      }),
    ).toThrow(/malformed grade entry/);
  });

  it("quarantines empty-Arabic rows instead of aborting (review A2)", async () => {
    const { arabicText } = await loadSlices();
    const arabic = parseHadithEdition("abudawud", "arabic", JSON.parse(arabicText));
    const indonesian = parseHadithEdition("abudawud", "indonesian", {
      metadata: { sections: { "1": "Purification" }, section_details: {} },
      hadiths: arabic.hadiths.map((h) => ({
        ...h,
        text: `terjemahan ${h.hadithnumber}`,
        grades: [],
      })),
    });
    // Zero out the Arabic text of hadith 5 (as the source genuinely ships
    // for many rows: 86 in ara-nasai, 29 in ara-malik).
    arabic.hadiths = arabic.hadiths.map((h) =>
      h.hadithnumber === "5" ? { ...h, text: "" } : h,
    );
    const { records, stats } = alignEditions(arabic, indonesian);
    expect(records.map((r) => r.hadithNo)).not.toContain("5");
    expect(stats.emptyPrimary).toBe(1);
    // The Indonesian counterpart was consumed, not reported unmatched.
    expect(stats.unmatched).toHaveLength(0);
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

  it("validates edition-map keys up front (review B5)", async () => {
    const { arabicText, indonesianText } = await loadSlices();
    // An unregistered collection code is rejected before parsing.
    expect(() =>
      buildHadithCorpus({
        arabic: { "not-a-collection": JSON.parse(arabicText) },
        indonesian: { "not-a-collection": JSON.parse(indonesianText) },
      }),
    ).toThrow(/unknown hadith collection/);
    // An extra Indonesian key with no Arabic counterpart is a composition
    // error, not a silently skipped edition.
    expect(() =>
      buildHadithCorpus({
        arabic: { abudawud: JSON.parse(arabicText) },
        indonesian: { abudawud: JSON.parse(indonesianText), bukhari: {} },
      }),
    ).toThrow(/no Arabic edition/);
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