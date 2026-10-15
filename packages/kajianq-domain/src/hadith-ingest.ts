import type { SourceInput, SourceParser } from "@app/rag-ingest";
import { alignEditions, type AlignmentStats } from "./hadith-align";
import { assertHadithIntegrity, parseHadithEdition } from "./hadith-parse";
import {
  HADITH_COLLECTION_NAMES,
  hadithMetadata,
  hadithSourceKey,
  isHadithCollection,
  mapGrades,
  type HadithCollection,
  type HadithRecord,
} from "./hadith-source";

/**
 * The domain wiring that turns parsed hadith sources into the engine's ingestion inputs: one parent
 * per (collection, book/section), one child per hadith, and one aligned pair per aligned hadith.
 * It is KajianQ domain logic; the engine seams receive it as typed values.
 */

/** Everything the hadith ingestion needs, already parsed and validated. */
export type HadithCorpus = {
  records: readonly HadithRecord[];
  alignment: Map<HadithCollection, AlignmentStats>;
};

/**
 * Parse + integrity-check the combined editions (throws on any violation). Edition keys are
 * validated against the registry up front, and the Indonesian map must mirror the Arabic one
 * exactly — extra or missing editions are a composition error, not a silent subset. `expected`
 * gates per-collection counts for subset runs; unmatched pairs are surfaced, never force-merged.
 */
export function buildHadithCorpus(
  input: { arabic: Record<string, unknown>; indonesian: Record<string, unknown> },
  expected?: Partial<Record<HadithCollection, number>>,
): HadithCorpus {
  const arabicKeys = Object.keys(input.arabic);
  if (arabicKeys.length === 0) {
    throw new Error("hadith ingestion: no Arabic editions in input");
  }
  for (const key of [...arabicKeys, ...Object.keys(input.indonesian)]) {
    if (!isHadithCollection(key)) {
      throw new Error(`hadith ingestion: unknown hadith collection "${key}"`);
    }
  }
  for (const key of arabicKeys) {
    if (!(key in input.indonesian)) {
      throw new Error(`hadith ingestion: ${key} has no Indonesian edition`);
    }
  }
  for (const key of Object.keys(input.indonesian)) {
    if (!(key in input.arabic)) {
      throw new Error(`hadith ingestion: ${key} has an Indonesian edition but no Arabic edition`);
    }
  }
  const records: HadithRecord[] = [];
  const alignment = new Map<HadithCollection, AlignmentStats>();
  for (const collection of arabicKeys as HadithCollection[]) {
    const arabic = parseHadithEdition(collection, "arabic", input.arabic[collection]);
    const indonesian = parseHadithEdition(collection, "indonesian", input.indonesian[collection]);
    const { records: aligned, stats } = alignEditions(arabic, indonesian);
    alignment.set(collection, stats);
    records.push(...aligned);
  }
  assertHadithIntegrity(records, expected);
  return { records, alignment };
}

/**
 * Group records by (collection, book), preserving the edition's order: the ordinal a
 * child gets must be stable across re-runs (the store upserts by (parentId, ordinal)).
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
 * Decode the archived raw bytes into the edition pieces the corpus needs: a length-prefixed
 * JSON-lines bundle — "collectionCount\n" plus one `{"collection", "arabic", "indonesian"}` line per
 * collection. The collection name rides in the line, so line order never determines identity.
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
      throw new Error(
        `hadith ingestion: archive bundle has duplicate collection ${parsed.collection}`,
      );
    }
    collections.push(parsed.collection);
    arabic[parsed.collection] = parsed.arabic;
    indonesian[parsed.collection] = parsed.indonesian;
  }
  return { arabic, indonesian };
}

/**
 * Build the length-prefixed JSON-lines archive bundle the SourceParser consumes: one
 * `{"collection", "arabic", "indonesian"}` line per edition, editions embedded as JSON values so
 * newlines stay encoded and each line stays one JSON value.
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
 * The domain `SourceParser` for `runIngestion`: parses from the raw archive bytes (the single source
 * of truth) into one parent per (collection, book/section) and one child per hadith. `expected` gates
 * exact per-collection counts for subset runs; full runs gate only on shape and duplicates, and the
 * report's quarantine stats surface upstream drift.
 */
export function hadithSourceParser(
  expected?: Partial<Record<HadithCollection, number>>,
): SourceParser {
  return async (input) => {
    const decoded = decodeHadithArchive(input);
    const corpus = buildHadithCorpus(decoded, expected);
    const byBook = groupByBook(corpus.records);
    const parents = [];
    for (const [, records] of byBook) {
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
 * Grade-consolidation summary for the ingestion report: graded records, dhaif-wins demotions, and
 * ungraded records (never fabricated), consolidated through the same `mapGrades` as the metadata.
 */
export function gradeConsolidationStats(records: readonly HadithRecord[]): {
  graded: number;
  dhaifWins: number;
  ungraded: number;
} {
  let graded = 0;
  let dhaifWins = 0;
  let ungraded = 0;
  for (const r of records) {
    if (r.grades.length === 0) {
      ungraded += 1;
      continue;
    }
    graded += 1;
    if (mapGrades(r.grades) === "dhaif") {
      dhaifWins += 1;
    }
  }
  return { graded, dhaifWins, ungraded };
}

export function corpusGradeStats(corpus: HadithCorpus): ReturnType<typeof gradeConsolidationStats> {
  return gradeConsolidationStats(corpus.records);
}
