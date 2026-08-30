import type { MorphToken } from "@app/contracts";
import type { ParsedParent, SourceParser } from "@app/rag-ingest";
import {
  ayahMetadata,
  surahSourceKey,
  TOTAL_AYAHS,
  type QuranAyah,
  type QuranSurahMeta,
} from "./quran-source";
import {
  assertAyahIntegrity,
  missingMorphologyCoverage,
  morphologyWordCountDiffs,
  parseMorphology,
  parseSurahFile,
  parseSurahList,
} from "./quran-parse";

/**
 * The domain wiring that turns parsed Quran sources into the engine's
 * ingestion inputs (#6): one parent per surah, one child per ayah, one
 * aligned pair per (Arabic, Indonesian) ayah for #24's concept-graph build
 * (ADR-0014), plus the LLM parent summarizer (surah summaries; parent
 * embeddings computed from summaries, not full text).
 *
 * Everything here is KajianQ domain logic — the engine seams
 * (`@app/rag-ingest`, `RagStore`, `Provider`) receive it as typed values.
 */

/** Everything the Quran ingestion needs, already parsed and validated. */
export type QuranCorpus = {
  surahs: readonly QuranSurahMeta[];
  ayahs: readonly QuranAyah[];
  /** Morphology keyed `surah:ayah` → per-token lemma/root. */
  morphology: Map<string, MorphToken[]>;
};

/**
 * Parse + integrity-check the combined sources (throws on any violation).
 * `expected` defaults to the full Tanzil corpus (114 surahs / 6,236 ayahs);
 * subset runs (tests, `--limit`) pass their own totals so the check stays
 * exact for what is being ingested.
 */
export function buildCorpus(
  input: {
    surahList: unknown;
    surahFiles: readonly unknown[];
    morphologyText: string;
  },
  expected?: { surahs?: number; ayahs?: number },
): QuranCorpus {
  const surahs = parseSurahList(input.surahList, expected?.surahs);
  const ayahs = input.surahFiles.flatMap((file) => parseSurahFile(file));
  assertAyahIntegrity(ayahs, surahs, expected);
  const morphology = parseMorphology(input.morphologyText);
  const missing = missingMorphologyCoverage(ayahs, morphology);
  if (missing.length > 0) {
    throw new Error(
      `quran integrity: morphology missing ${missing.length} ayah(s): ${missing.slice(0, 5).join(", ")}`,
    );
  }
  return { surahs, ayahs, morphology };
}

/** Segmentation diffs for the report — surfaced, never force-merged. */
export function corpusWordCountDiffs(
  corpus: QuranCorpus,
): ReturnType<typeof morphologyWordCountDiffs> {
  return morphologyWordCountDiffs(corpus.ayahs, corpus.morphology);
}

/** Group ayahs by surah, preserving order. */
function groupBySurah(ayahs: readonly QuranAyah[]): Map<number, QuranAyah[]> {
  const bySurah = new Map<number, QuranAyah[]>();
  for (const ayah of ayahs) {
    const list = bySurah.get(ayah.surah) ?? [];
    list.push(ayah);
    bySurah.set(ayah.surah, list);
  }
  return bySurah;
}

/** Build the aligned (Arabic, Indonesian) pairs with morphology (#24's seed). */
export function buildAlignedPairs(corpus: QuranCorpus): import("./quran-source").QuranAlignedPair[] {
  return corpus.ayahs.map((ayah) => {
    const key = `${ayah.surah}:${ayah.ayah}`;
    return {
      pairId: `quran-pair:${key}`,
      citation: { sourceType: "quran", surah: ayah.surah, ayah: ayah.ayah },
      textPrimary: ayah.textAr,
      textSecondary: ayah.textId,
      morphology: corpus.morphology.get(key) ?? [],
    };
  });
}

/**
 * The domain `SourceParser` for `runIngestion`: one parent per surah
 * (children keep chapter context through the parent relation), one child
 * per ayah with the citation + morphology in metadata. `expectedAyahs`
 * defaults to the full Tanzil total; subset runs pass their own count.
 */
export function quranSourceParser(
  corpus: QuranCorpus,
  expectedAyahs: number = TOTAL_AYAHS,
): SourceParser {
  return async () => {
    const bySurah = groupBySurah(corpus.ayahs);
    const parents: ParsedParent[] = [];
    for (const surah of corpus.surahs) {
      const ayahs = bySurah.get(surah.number) ?? [];
      if (ayahs.length === 0) {
        throw new Error(`quran ingestion: surah ${surah.number} has no ayahs`);
      }
      parents.push({
        sourceKey: surahSourceKey(surah.number),
        title: `QS. ${surah.name}`,
        metadata: {
          sourceType: "quran",
          surah: surah.number,
          surahName: surah.name,
          surahNameId: surah.nameId,
          ayahCount: surah.ayahCount,
        },
        children: ayahs.map((ayah, i) => ({
          sourceKey: `${surahSourceKey(surah.number)}:${ayah.ayah}`,
          textRaw: ayah.textAr,
          textPrimary: ayah.textAr,
          textSecondary: ayah.textId,
          citation: {
            sourceType: "quran",
            surah: ayah.surah,
            ayah: ayah.ayah,
          } as const,
          metadata: {
            ...ayahMetadata(ayah),
            morphology: corpus.morphology.get(`${ayah.surah}:${ayah.ayah}`) ?? [],
          },
          ordinal: i,
        })),
      });
    }
    if (corpus.ayahs.length !== expectedAyahs) {
      throw new Error(`quran ingestion: expected ${expectedAyahs} ayahs, got ${corpus.ayahs.length}`);
    }
    return parents;
  };
}
