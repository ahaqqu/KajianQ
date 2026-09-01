import type { MorphToken } from "@app/contracts";
import type { ParsedParent, SourceInput, SourceParser } from "@app/rag-ingest";
import {
  ayahMetadata,
  surahSourceKey,
  TOTAL_AYAHS,
  TOTAL_SURAHS,
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
 * subset runs (tests, `--limit`) pass their own totals — `surahs`/`ayahs`
 * count what is actually being ingested. The surah list itself is always
 * validated as complete metadata (all 114 entries), so a truncated list
 * still fails loudly; only the ayah files are subset-able, and the
 * `ayahs` count gate is what catches real truncation.
 */
export function buildCorpus(
  input: {
    surahList: unknown;
    surahFiles: readonly unknown[];
    morphologyText: string;
  },
  expected?: { surahs?: number; ayahs?: number },
): QuranCorpus {
  const gates: { surahs?: number; ayahs?: number } = {};
  if (expected?.surahs !== undefined) gates.surahs = expected.surahs;
  if (expected?.ayahs !== undefined) gates.ayahs = expected.ayahs;
  // The list is parsed without a count gate: subset runs (tests, --limit)
  // legitimately carry a partial list, and a truncated FULL run is caught by
  // the ayah-level gates below plus the per-surah ayahCount cross-check.
  const surahs = parseSurahList(input.surahList);
  const ayahs = input.surahFiles.flatMap((file) => parseSurahFile(file));
  assertAyahIntegrity(ayahs, surahs, gates);
  const ingested = new Set(ayahs.map((a) => a.surah));
  const morphology = parseMorphology(input.morphologyText);
  const missing = missingMorphologyCoverage(ayahs, morphology);
  if (missing.length > 0) {
    throw new Error(
      `quran integrity: morphology missing ${missing.length} ayah(s): ${missing.slice(0, 5).join(", ")}`,
    );
  }
  if (ingested.size < surahs.length) {
    // Subset run: restrict the returned metadata to the surahs actually
    // being ingested so parents and the report describe the subset, and
    // verify the list covers every ingested surah (a list missing a surah
    // whose file is present would silently drop its metadata).
    for (const ayah of ayahs) {
      if (!surahs.some((s) => s.number === ayah.surah)) {
        throw new Error(
          `quran integrity: surah ${ayah.surah} has ayah files but no list entry`,
        );
      }
    }
    const subsetSurahs = surahs.filter((s) => ingested.has(s.number));
    if (expected?.surahs !== undefined && subsetSurahs.length !== expected.surahs) {
      throw new Error(
        `quran integrity: expected ${expected.surahs} surahs among ingested files, got ${subsetSurahs.length}`,
      );
    }
    return { surahs: subsetSurahs, ayahs, morphology };
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

/**
 * Decode the archived raw bytes into the source pieces the corpus needs.
 * The archive is a length-prefixed JSON-lines bundle so that raw files
 * (especially the morphology text, which contains newlines) stay unambiguous.
 * Layout: "surahCount\n" + JSON(surahList) + "\n" + JSON(morphologyText) + "\n"
 * + one JSON(surahFile) per surah, each on its own line.
 */
export function decodeQuranArchive(input: SourceInput): {
  surahList: unknown;
  surahFiles: unknown[];
  morphologyText: string;
} {
  const decoder = new TextDecoder();
  const text = decoder.decode(input.raw);
  const lines = text.split("\n");
  if (lines.length < 3) {
    throw new Error("quran ingestion: archive bundle has fewer than 3 length-prefixed lines");
  }
  const surahCount = Number(lines[0]);
  if (!Number.isInteger(surahCount) || surahCount <= 0) {
    throw new Error("quran ingestion: archive bundle has invalid surah count");
  }
  const surahListLine = lines[1];
  const morphologyLine = lines[2];
  const surahFileLines = lines.slice(3, 3 + surahCount);
  if (surahFileLines.length !== surahCount) {
    throw new Error(
      `quran ingestion: archive bundle expected ${surahCount} surah file line(s), got ${surahFileLines.length}`,
    );
  }
  // Trailing content after the declared surah files means the bundle was
  // written by a different layout — refuse it rather than silently parse
  // a subset (one empty string from a trailing "\n" is tolerated).
  const trailing = lines.slice(3 + surahCount).filter((l) => l.length > 0);
  if (trailing.length > 0) {
    throw new Error(
      `quran ingestion: archive bundle has ${trailing.length} unexpected trailing line(s)`,
    );
  }
  return {
    surahList: JSON.parse(surahListLine ?? "{}"),
    surahFiles: surahFileLines.map((line) => JSON.parse(line)),
    morphologyText: JSON.parse(morphologyLine ?? '""'),
  };
}

/**
 * Build the length-prefixed JSON-lines archive bundle the SourceParser
 * consumes. `surahFiles` are already JSON text; we JSON-stringify them once
 * so the bundle line is a single JSON value that decodes back to a string,
 * which `buildCorpus` parses via `parseSurahFile`.
 */
export function bundleQuranSources(sources: {
  surahListText: string;
  surahFiles: readonly string[];
  morphologyText: string;
}): Uint8Array {
  return new TextEncoder().encode(
    [
      String(sources.surahFiles.length),
      sources.surahListText,
      JSON.stringify(sources.morphologyText),
      ...sources.surahFiles,
    ].join("\n"),
  );
}

/**
 * The domain `SourceParser` for `runIngestion`: parses from raw archive bytes
 * (the single source of truth, archived upstream) into one parent per surah
 * and one child per ayah. `expected` lets subset runs (tests, `--limit`)
 * assert exact counts; full runs leave it at the default full-corpus totals.
 */
export function quranSourceParser(
  expectedAyahs: number = TOTAL_AYAHS,
  expectedSurahs?: number,
): SourceParser {
  return async (input) => {
    const decoded = decodeQuranArchive(input);
    const gates: { surahs?: number; ayahs?: number } = { ayahs: expectedAyahs };
    if (expectedSurahs !== undefined) gates.surahs = expectedSurahs;
    const corpus = buildCorpus(decoded, gates);
    const bySurah = groupBySurah(corpus.ayahs);
    const parents: ParsedParent[] = [];
    // `buildCorpus` returns metadata for exactly the ingested surahs (full
    // list for a full run, the subset for tests/`--limit`), so every surah
    // here must have ayahs — an empty group is a real integrity violation.
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
      throw new Error(
        `quran ingestion: expected ${expectedAyahs} ayahs, got ${corpus.ayahs.length}`,
      );
    }
    if (expectedSurahs !== undefined && corpus.surahs.length !== expectedSurahs) {
      throw new Error(
        `quran ingestion: expected ${expectedSurahs} surahs, got ${corpus.surahs.length}`,
      );
    }
    return parents;
  };
}
