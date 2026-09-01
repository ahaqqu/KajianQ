import type { SourceInput, SourceParser } from "@app/rag-ingest";
import {
  alignEditions,
  assertHadithIntegrity,
  gradeConsolidationStats,
  parseHadithEdition,
  type AlignmentStats,
} from "./hadith-parse";
import {
  HADITH_COLLECTION_NAMES,
  hadithMetadata,
  hadithSourceKey,
  type HadithCollection,
  type HadithRecord,
} from "./hadith-source";

/**
 * The domain wiring that turns parsed hadith sources into the engine's
 * ingestion inputs (#7): one parent per (collection, book/section) with the
 * section title as title, one child per hadith with the consolidated grade
 * in metadata, and one aligned (Arabic, Indonesian) pair per fully-aligned
 * hadith for #24's concept-graph build (ADR-0014; morphology arrives later —
 * ADR-0025 defers CAMeL Tools lemmatization to the pre-#24 enrichment step).
 *
 * Everything here is KajianQ domain logic — the engine seams
 * (`@app/rag-ingest`, `RagStore`, `Provider`) receive it as typed values.
 */

/** Everything the hadith ingestion needs, already parsed and validated. */
export type HadithCorpus = {
  records: readonly HadithRecord[];
  alignment: Map<HadithCollection, AlignmentStats>;
};

/**
 * Parse + integrity-check the combined editions (throws on any violation).
 * `expected` lets subset runs (tests, `--limit`) gate the per-collection
 * counts they actually ingest; full runs pass the full expected counts from
 * the CLI. Unmatched pairs are surfaced in the stats, never force-merged.
 */
export function buildHadithCorpus(
  input: { arabic: Record<string, unknown>; indonesian: Record<string, unknown> },
  expected?: Partial<Record<HadithCollection, number>>,
): HadithCorpus {
  const records: HadithRecord[] = [];
  const alignment = new Map<HadithCollection, AlignmentStats>();
  for (const collection of Object.keys(input.arabic) as HadithCollection[]) {
    const arabic = parseHadithEdition(collection, "arabic", input.arabic[collection]);
    const indonesianText = input.indonesian[collection];
    if (indonesianText === undefined) {
      throw new Error(`hadith ingestion: ${collection} has no Indonesian edition`);
    }
    const indonesian = parseHadithEdition(collection, "indonesian", indonesianText);
    const { records: aligned, stats } = alignEditions(arabic, indonesian);
    alignment.set(collection, stats);
    records.push(...aligned);
  }
  assertHadithIntegrity(records, expected);
  return { records, alignment };
}

/**
 * Group records by (collection, book), preserving the edition's order — the
 * ordinal a child gets must be stable across re-runs (the store upserts
 * children by (parentId, ordinal)).
 */
function groupByBook(records: readonly HadithRecord[]): Map<string, HadithRecord[]> {
  const byBook = new Map<string, HadithRecord[]>();
  for (const record of records) {
    const key = `${record.collection}:${record.bookNo}`;
    const list = byBook.get(key) ?? [];
    list.push(record);
    byBook.set(key, list);
  }
  return byBook;
}

/**
 * Decode the archived raw bytes into the edition pieces the corpus needs.
 * The archive is a length-prefixed JSON-lines bundle (same layout pattern as
 * the Quran archive): "collectionCount\n" + per collection one line —
 * `{"collection": name, "arabic": <edition>, "indonesian": <edition>}`.
 * The collection name rides inside the bundle line, so the decoder never
 * infers identity from line order alone.
 */
export function decodeHadithArchive(input: SourceInput): {
  arabic: Record<string, unknown>;
  indonesian: Record<string, unknown>;
} {
  const decoder = new TextDecoder();
  // Blank trailing lines from a trailing "\n" are tolerated, not content.
  const lines = decoder
    .decode(input.raw)
    .split("\n")
    .filter((l, i, arr) => l.length > 0 || i < arr.length - 1);
  if (lines.length < 1) {
    throw new Error("hadith ingestion: archive bundle is empty");
  }
  const count = Number(lines[0]);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("hadith ingestion: archive bundle has invalid collection count");
  }
  const contentLines = lines.slice(1).filter((l) => l.length > 0);
  if (contentLines.length < count) {
    throw new Error(
      `hadith ingestion: archive bundle expected ${count} edition line(s), got ${contentLines.length}`,
    );
  }
  if (contentLines.length > count) {
    throw new Error(
      `hadith ingestion: archive bundle has ${contentLines.length - count} unexpected trailing line(s)`,
    );
  }
  const arabic: Record<string, unknown> = {};
  const indonesian: Record<string, unknown> = {};
  const collections: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const line = contentLines[i];
    if (line === undefined) {
      throw new Error(`hadith ingestion: archive bundle is missing edition line at index ${i}`);
    }
    const parsed = JSON.parse(line) as {
      collection?: unknown;
      arabic?: unknown;
      indonesian?: unknown;
    };
    if (
      typeof parsed.collection !== "string" ||
      typeof parsed.arabic !== "object" ||
      parsed.arabic === null ||
      typeof parsed.indonesian !== "object" ||
      parsed.indonesian === null
    ) {
      throw new Error(
        `hadith ingestion: archive bundle edition line ${i} must carry {collection, arabic, indonesian}`,
      );
    }
    if (collections.includes(parsed.collection)) {
      throw new Error(`hadith ingestion: archive bundle has duplicate collection ${parsed.collection}`);
    }
    collections.push(parsed.collection);
    arabic[parsed.collection] = parsed.arabic;
    indonesian[parsed.collection] = parsed.indonesian;
  }
  return { arabic, indonesian };
}

/**
 * Build the length-prefixed JSON-lines archive bundle the SourceParser
 * consumes. Each line is `{"collection", "arabic", "indonesian"}` with the
 * two editions as embedded JSON values (stringified once, so newlines
 * inside the editions stay encoded and each line stays a single JSON value).
 */
export function bundleHadithSources(
  editions: readonly { collection: HadithCollection; arabicText: string; indonesianText: string }[],
): Uint8Array {
  const lines: string[] = [String(editions.length)];
  for (const edition of editions) {
    lines.push(
      JSON.stringify({
        collection: edition.collection,
        arabic: JSON.parse(edition.arabicText),
        indonesian: JSON.parse(edition.indonesianText),
      }),
    );
  }
  return new TextEncoder().encode(lines.join("\n"));
}

/**
 * The domain `SourceParser` for `runIngestion`: parses from raw archive
 * bytes (the single source of truth, archived upstream) into one parent per
 * (collection, book/section) and one child per hadith. `expected` lets
 * subset runs (tests, `--limit`) gate exact per-collection counts; full runs
 * gate only on shape + duplicates — edition sizes drift upstream, and the
 * unmatched/quarantine stats in the report are what surface drift.
 */
export function hadithSourceParser(
  expected?: Partial<Record<HadithCollection, number>>,
): SourceParser {
  return async (input) => {
    const decoded = decodeHadithArchive(input);
    const corpus = buildHadithCorpus(decoded, expected);
    const byBook = groupByBook(corpus.records);
    const parents = [];
    for (const [key, records] of byBook) {
      const first = records[0];
      if (first === undefined) continue;
      const title =
        first.bookName !== null && first.bookName.length > 0
          ? `${HADITH_COLLECTION_NAMES[first.collection]} — ${first.bookName}`
          : `${HADITH_COLLECTION_NAMES[first.collection]} — book ${first.bookNo}`;
      parents.push({
        sourceKey: hadithSourceKey(first.collection, first.bookNo),
        title,
        metadata: {
          sourceType: "hadith",
          collection: first.collection,
          book: first.bookNo,
          bookName: first.bookName,
          hadithCount: records.length,
        },
        children: records.map((record, i) => ({
          sourceKey: `${hadithSourceKey(record.collection, record.bookNo)}:${record.hadithNo}`,
          textRaw: record.textAr,
          textPrimary: record.textAr,
          textSecondary: record.textId,
          citation: {
            sourceType: "hadith",
            collection: record.collection,
            hadithNo: record.hadithNo,
          },
          metadata: {
            ...hadithMetadata(record),
            morphology: [],
          },
          ordinal: i,
        })),
      });
    }
    return parents;
  };
}

/**
 * Consolidation summary over the whole corpus for the report — how many
 * hadith are graded, how many the dhaif-wins policy demoted, how many are
 * ungraded (grade = null, never fabricated).
 */
export function corpusGradeStats(
  corpus: HadithCorpus,
): ReturnType<typeof gradeConsolidationStats> {
  return gradeConsolidationStats(corpus.records);
}