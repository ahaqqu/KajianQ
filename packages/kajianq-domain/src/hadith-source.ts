/**
 * KajianQ hadith ingestion — domain pack source model, owning the hadith-specific shapes: the
 * (collection, hadith number) address and the `HR. Collection no. N (Grade)` citation format.
 *
 * Per-grader grades ship on the *Arabic* edition entries; sanad is not structured in v1, so the
 * isnad stays embedded in the verbatim `text_raw`.
 */

export type HadithSourceType = "hadith";

import { GRADES, type Grade } from "./filters";

/**
 * Hadith authenticity classification (CONTEXT.md "Grade"), owned by `./filters` — the one list that
 * retrieval filters by. A leaf import, never the barrel: `filters.ts` imports nothing, so no cycle.
 */
export { GRADES, type Grade };

/**
 * The v1 collections: the source provides Arabic + Indonesian editions with per-grader grades for
 * these. Musnad Ahmad and Sunan ad-Darimi are absent, not force-merged from an ungraded scraper.
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

export function isHadithCollection(value: unknown): value is HadithCollection {
  return typeof value === "string" && (HADITH_COLLECTIONS as readonly string[]).includes(value);
}

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
 * One aligned hadith record: `text_raw` carries the Arabic matn with its isnad verbatim (v1 does not
 * separate them), plus the translation when the edition has one and the raw per-grader grades.
 */
export type HadithRecord = {
  collection: HadithCollection;
  /** The collection's own hadith number (the citation number). */
  hadithNo: string;
  bookNo: number;
  bookName: string | null;
  /** Arabic text, verbatim (the immutable `text_raw`). */
  textAr: string;
  /** Indonesian translation; null when the edition text is empty. */
  textId: string | null;
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
 * The weak-class vocabulary of the source's grade strings: any occurrence makes the hadith `dhaif`.
 * `Mauquf`/`Muquf`/`Maqtu` are deliberately absent (attribution-scope, not defects), as is `Marfoo` (an
 * elevated chain). `mapGrades` and the report stats read this one list.
 */
const WEAK_GRADE_RE = /daif|dhaif|munkar|shadh|mansukh|mawdu|batil|mursal/i;

export function isWeakGrade(grade: string): boolean {
  return WEAK_GRADE_RE.test(grade);
}

/**
 * Consolidate the source's per-grader grades into the single filterable `Grade`, conservative
 * dhaif-wins (ADR-0026): any grader asserting a weak class makes the hadith `dhaif` — under-grading is
 * the safe failure mode, since dhaif material is always flagged at retrieval. Otherwise the weakest
 * agreed positive rating wins ("Hasan Sahih" is weaker than plain Sahih); empty grades → null, never
 * fabricated, and `mutawatir` is never self-asserted here.
 */
export function mapGrades(grades: readonly { name: string; grade: string }[]): Grade | null {
  if (grades.length === 0) return null;
  const joined = grades.map((g) => g.grade).join(" | ");
  if (isWeakGrade(joined)) return "dhaif";
  if (/hasan/i.test(joined)) return "hasan";
  if (/sahih|moutabar|mu'alla/i.test(joined)) return "sahih";
  return null;
}

/** Format the user-facing citation label (CONTEXT.md): `HR. Bukhari no. 573 (Sahih)`.
 Grade suffix omitted when ungraded. */
export function formatHadithCitation(c: Omit<HadithCitation, "sourceType">): string {
  const collection = HADITH_COLLECTION_NAMES[c.collection] ?? c.collection;
  const base = `HR. ${collection} no. ${c.hadithNo}`;
  return c.grade ? `${base} (${capitalize(c.grade)})` : base;
}

/** Parse an `HR. Collection no. N (Grade)?` label back into its citation; the collection name
 matches the registry's display names, multi-word ones included. */
export function parseHadithCitation(label: string): HadithCitation | null {
  const match = /^HR\.\s*(.+?) no\. (\S+?)(?: \((\w+)\))?$/.exec(label.trim());
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
