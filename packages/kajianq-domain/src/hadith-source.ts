import { GRADES, type Grade } from "./index";

/**
 * KajianQ hadith ingestion — domain pack source model (#7).
 *
 * This module owns the hadith-specific shapes: the (collection, hadith
 * number) address, the `HR. Collection no. N (Grade)` citation format
 * (CONTEXT.md), and the per-grader grade consolidation policy (ADR-0025).
 * The engine packages never name any of this vocabulary (dars-pluggability
 * rule 1); it arrives here as typed values and is handed to `@app/rag-ingest`
 * through its generic seams.
 *
 * v1 source is fawazahmed0/hadith-api (Unlicense; ADR-0025): per-grader
 * grades ship on the *Arabic* edition entries; sanad is not structured in any
 * v1 dataset — the isnad stays embedded in the verbatim `text_raw`, and
 * per-chain grades remain v2 (ADR-0012, Sanadset).
 */

/** The source-type discriminator written into every hadith chunk's metadata. */
export type HadithSourceType = "hadith";

/**
 * The v1 collections (ADR-0025): the source provides Arabic + Indonesian
 * editions with per-grader grades for these seven. Musnad Ahmad and Sunan
 * ad-Darimi are absent from the source and are documented, not force-merged
 * from an ungraded scraper.
 */
export const HADITH_COLLECTIONS = [
  "bukhari",
  "muslim",
  "abudawud",
  "tirmidhi",
  "nasai",
  "ibnmajah",
  "malik",
] as const;

export type HadithCollection = (typeof HADITH_COLLECTIONS)[number];

/** Display names for the collection registry (citation + parent titles). */
export const HADITH_COLLECTION_NAMES: Record<HadithCollection, string> = {
  bukhari: "Bukhari",
  muslim: "Muslim",
  abudawud: "Abu Dawud",
  tirmidhi: "Tirmidhi",
  nasai: "Nasai",
  ibnmajah: "Ibn Majah",
  malik: "Malik",
};

/**
 * One aligned hadith record: the Arabic matn (with its isnad — the v1
 * sources do not separate them, so `text_raw` carries both verbatim) plus
 * the Indonesian translation when the edition has one, and the raw
 * per-grader grade array verbatim from the source.
 */
export type HadithRecord = {
  collection: HadithCollection;
  /** The collection's own hadith number (the citation number). */
  hadithNo: string;
  /** Book/section number within the collection (the parent container). */
  bookNo: number;
  /** Book/section title, from the edition's section metadata. */
  bookName: string | null;
  /** Arabic text, verbatim (immutable `text_raw`). */
  textAr: string;
  /** Indonesian translation; null when the edition text is empty. */
  textId: string | null;
  /** Per-grader grades verbatim from the source: `{name, grade}`. */
  grades: readonly { name: string; grade: string }[];
};

/** The domain citation shape stored in `doc_children.citation`. */
export type HadithCitation = {
  sourceType: HadithSourceType;
  collection: HadithCollection;
  hadithNo: string;
  /** The consolidated filterable grade, when the source grades the hadith. */
  grade?: Grade;
};

/**
 * Consolidate the source's per-grader grades into the single filterable
 * `Grade` (CONTEXT.md vocabulary), conservative dhaif-wins (ADR-0025): any
 * grader asserting a weak class (Daif/Munkar/Shadh/…) makes the hadith
 * `dhaif` — under-grading is the safe failure mode because dhaif material is
 * always flagged at retrieval. Otherwise the strongest agreed positive
 * rating wins (hasan beats sahih: "Hasan Sahih" and "Sahih Lighairihi" are
 * weaker than plain Sahih). Empty grades → null, never fabricated;
 * `mutawatir` is never self-asserted from this source.
 */
export function mapGrades(
  grades: readonly { name: string; grade: string }[],
): Grade | null {
  if (grades.length === 0) return null;
  const joined = grades.map((g) => g.grade).join(" | ");
  if (/daif|dhaif|munkar|shadh|mansukh|marfoo/i.test(joined)) return "dhaif";
  if (/hasan/i.test(joined)) return "hasan";
  if (/sahih|moutabar|mu'alla/i.test(joined)) return "sahih";
  return null;
}

/** Format the user-facing citation label (CONTEXT.md): `HR. Bukhari no. 573 (Sahih)`.
 Grade suffix omitted when ungraded. */
export function formatHadithCitation(
  c: Omit<HadithCitation, "sourceType">,
): string {
  const collection = HADITH_COLLECTION_NAMES[c.collection] ?? c.collection;
  const base = `HR. ${collection} no. ${c.hadithNo}`;
  return c.grade ? `${base} (${capitalize(c.grade)})` : base;
}

/** Parse an `HR. Collection no. N (Grade)?` label back into its citation. */
export function parseHadithCitation(label: string): HadithCitation | null {
  const match = /^HR\.\s*(\w+) no\. (\S+?)(?: \((\w+)\))?$/.exec(label.trim());
  if (!match) return null;
  const collection = (Object.keys(HADITH_COLLECTION_NAMES) as HadithCollection[]).find(
    (c) => HADITH_COLLECTION_NAMES[c] === match[1],
  );
  if (collection === undefined || match[2] === undefined) return null;
  const grade = match[3]?.toLowerCase();
  return {
    sourceType: "hadith",
    collection,
    hadithNo: match[2],
    ...(grade !== undefined && (GRADES as readonly string[]).includes(grade)
      ? { grade: grade as Grade }
      : {}),
  };
}

/** Stable provenance keys — the store upserts on them (idempotent ingestion). */
export function hadithSourceKey(collection: HadithCollection, bookNo: number): string {
  return `hadith/${collection}/section/${bookNo}`;
}

export function hadithPairId(collection: HadithCollection, hadithNo: string): string {
  return `hadith-pair:${collection}:${hadithNo}`;
}

/** Metadata written on every hadith child chunk (retrieval filters). */
export function hadithMetadata(record: HadithRecord): Record<string, unknown> {
  const grade = mapGrades(record.grades);
  return {
    sourceType: "hadith" satisfies HadithSourceType,
    collection: record.collection,
    hadithNo: record.hadithNo,
    book: record.bookNo,
    grade,
    grades: record.grades,
    citation: formatHadithCitation({
      collection: record.collection,
      hadithNo: record.hadithNo,
      ...(grade !== null ? { grade } : {}),
    }),
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}