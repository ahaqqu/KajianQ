import { describe, expect, it } from "vitest";
import {
  authorProbes,
  benchDocIdHadith,
  benchDocIdQuran,
  corpusFingerprint,
  hadithBenchDocs,
  quranBenchDocs,
  stratifiedSubset,
  strideSample,
  type DomainBenchDoc,
} from "./embed-bench-corpus";
import type { HadithRecord } from "./hadith-source";
import type { QuranAyah } from "./quran-source";

const ayah = (surah: number, ayahNo: number, ar: string, id: string): QuranAyah => ({
  surah,
  ayah: ayahNo,
  textAr: ar,
  textId: id,
});

const hadith = (collection: HadithRecord["collection"], hadithNo: string): HadithRecord => ({
  collection,
  hadithNo,
  bookNo: 1,
  bookName: null,
  textAr: `نص الحديث ${hadithNo}`,
  textId: `terjemahan hadis ${hadithNo}`,
  grades: [],
});

describe("doc ids + builders", () => {
  it("builds one doc per ayah with both track texts and stable ids", () => {
    const docs = quranBenchDocs([ayah(1, 1, "بِسْمِ اللّٰهِ", "Dengan nama Allah")]);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.id).toBe(benchDocIdQuran(1, 1));
    expect(docs[0]!.textAr).toBe("بِسْمِ اللّٰهِ");
    expect(docs[0]!.textId).toBe("Dengan nama Allah");
    expect(docs[0]!.sourceType).toBe("quran");
  });

  it("skips hadith records with empty Arabic or missing translation", () => {
    const kept = hadithBenchDocs([hadith("bukhari", "1")]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.id).toBe(benchDocIdHadith("bukhari", "1"));
    expect(kept[0]!.sourceType).toBe("hadith");

    const empty = hadithBenchDocs([
      { ...hadith("bukhari", "2"), textAr: "  " },
      { ...hadith("bukhari", "3"), textId: null },
    ]);
    expect(empty).toHaveLength(0);
  });
});

describe("corpusFingerprint", () => {
  it("is stable for the same corpus and sensitive to content", () => {
    const docs: DomainBenchDoc[] = [
      { id: "a", textAr: "النص", textId: "teks", sourceType: "quran" },
      { id: "b", textAr: "نص آخر", textId: "teks lain", sourceType: "hadith" },
    ];
    expect(corpusFingerprint(docs)).toBe(corpusFingerprint([...docs]));
    expect(corpusFingerprint(docs)).not.toBe(
      corpusFingerprint([{ ...docs[0]!, textAr: "تغيير" }, docs[1]!]),
    );
    expect(corpusFingerprint([])).toContain(":0");
  });
});

describe("strideSample", () => {
  it("returns the full array when count >= length", () => {
    const items = [1, 2, 3];
    expect(strideSample(items, 5, 1)).toEqual([1, 2, 3]);
    expect(strideSample(items, 3, 1)).toEqual([1, 2, 3]);
  });

  it("returns an empty array for count <= 0", () => {
    expect(strideSample([1, 2], 0, 1)).toEqual([]);
    expect(strideSample([1, 2], -1, 1)).toEqual([]);
  });

  it("is deterministic and spreads across the array", () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const first = strideSample(items, 3, 1);
    expect(first).toEqual(strideSample(items, 3, 1));
    expect(new Set(first).size).toBe(3);
    expect(first[0]).not.toBe(first[1]);
  });
});

describe("authorProbes", () => {
  it("authors probes whose relevant ids reference real doc ids", () => {
    const docs: DomainBenchDoc[] = [
      { id: "d1", textAr: "النص الأول", textId: "teks pertama", sourceType: "quran" },
      { id: "d2", textAr: "النص الثاني", textId: "teks kedua", sourceType: "hadith" },
    ];
    const probes = authorProbes(
      docs,
      { crossLingual: 2, monolingual: 2, idTrack: 0 },
      corpusFingerprint(docs),
    );
    expect(probes.crossLingual).toHaveLength(2);
    for (const p of [...probes.crossLingual, ...probes.monolingual]) {
      expect(p.relevantIds).toHaveLength(1);
      expect(docs.some((d) => d.id === p.relevantIds[0])).toBe(true);
    }
    // Cross-lingual probes query in the secondary (ID) text.
    for (const p of probes.crossLingual) {
      const doc = docs.find((d) => p.relevantIds.includes(d.id))!;
      expect(p.text).toBe(doc.textId);
    }
    // Monolingual probes query in the primary (AR) text.
    for (const p of probes.monolingual) {
      const doc = docs.find((d) => p.relevantIds.includes(d.id))!;
      expect(p.text).toBe(doc.textAr);
    }
  });

  it("produces deterministic probes across calls", () => {
    const docs: DomainBenchDoc[] = Array.from({ length: 50 }, (_, i) => ({
      id: `d${i}`,
      textAr: `ar ${i}`,
      textId: `id ${i}`,
      sourceType: "quran",
    }));
    const a = authorProbes(docs, { crossLingual: 10, monolingual: 10, idTrack: 0 }, "f");
    const b = authorProbes(docs, { crossLingual: 10, monolingual: 10, idTrack: 0 }, "f");
    expect(a).toEqual(b);
  });

  it("excludes docs without a secondary text from secondary-track probes", () => {
    const docs: DomainBenchDoc[] = [
      { id: "d1", textAr: "ar 1", textId: "id 1", sourceType: "quran" },
      { id: "d2", textAr: "ar 2", textId: null, sourceType: "hadith" },
    ];
    const probes = authorProbes(
      docs,
      { crossLingual: 5, monolingual: 5, idTrack: 0 },
      corpusFingerprint(docs),
    );
    // The null-textId doc can never be a secondary-track probe's source.
    for (const p of probes.crossLingual) {
      expect(p.relevantIds).not.toContain("d2");
    }
    // Monolingual probes still only draw from docs with both tracks (the
    // runner reuses one vector set per probe direction).
    expect(probes.monolingual.every((p) => p.relevantIds[0] === "d1")).toBe(true);
  });
});

describe("stratifiedSubset", () => {
  const quran = (n: number): DomainBenchDoc[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `q${i}`,
      textAr: `ar ${i}`,
      textId: `id ${i}`,
      sourceType: "quran",
    }));
  const hadith = (n: number): DomainBenchDoc[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `h${i}`,
      textAr: `ar h${i}`,
      textId: `id h${i}`,
      sourceType: "hadith",
    }));

  it("keeps each group's share of the budget and never exceeds group size", () => {
    const subset = stratifiedSubset(quran(600), hadith(400), { total: 100 });
    expect(subset).toHaveLength(100);
    expect(subset.filter((d) => d.sourceType === "quran")).toHaveLength(60);
    expect(subset.filter((d) => d.sourceType === "hadith")).toHaveLength(40);
  });

  it("clamps to group size and redistributes the remainder to the other group", () => {
    // Budget 100 over a 3+2 corpus: every row fits, and both groups are
    // capped at their full size (the other group cannot exceed its own).
    const subset = stratifiedSubset(quran(3), hadith(2), { total: 100 });
    expect(subset).toHaveLength(5);
    expect(subset.filter((d) => d.sourceType === "quran")).toHaveLength(3);
    expect(subset.filter((d) => d.sourceType === "hadith")).toHaveLength(2);
    // Proportional split over a lopsided corpus: 5 quran / 900 hadith at
    // budget 100 keeps ~1 quran (share 0.55%) + 99 hadith.
    const lopsided = stratifiedSubset(quran(5), hadith(900), { total: 100 });
    expect(lopsided.filter((d) => d.sourceType === "quran")).toHaveLength(1);
    expect(lopsided.filter((d) => d.sourceType === "hadith")).toHaveLength(99);
  });

  it("is deterministic across calls", () => {
    const a = stratifiedSubset(quran(300), hadith(200), { total: 50 });
    const b = stratifiedSubset(quran(300), hadith(200), { total: 50 });
    expect(a).toEqual(b);
  });

  it("requests of zero return an empty subset", () => {
    expect(stratifiedSubset(quran(10), hadith(10), { total: 0 })).toHaveLength(0);
  });
});
