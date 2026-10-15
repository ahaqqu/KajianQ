import { HADITH_COLLECTIONS, type HadithCollection, type HadithRecord } from "./hadith-source";

/**
 * Parsers for the hadith corpus sources: decode and normalize one edition file at a time.
 * The parsed `arabicnumber`/`reference.book` pair is the cross-edition alignment join key
 * (`hadith-align.ts`). Grades ship only on the Arabic editions, so the Indonesian edition's
 * `grades` array is ignored; raw strings are preserved verbatim — nothing here rewrites text.
 */

/**
 * One hadith entry of an edition JSON file, after normalization: the source ships
 * `hadithnumber`/`arabicnumber` as JSON numbers, and the parser accepts both numbers
 * and strings, normalizing to strings.
 */
export type EditionHadith = {
  hadithnumber: string;
  arabicnumber: string;
  text: string;
  grades: { name: string; grade: string }[];
  reference: { book: number; hadith: string | number };
};

export type HadithEdition = {
  collection: HadithCollection;
  language: "arabic" | "indonesian";
  /** Book number → title; empty titles are allowed. */
  sections: Map<number, string>;
  sectionDetails: Map<
    number,
    { first: string; last: string; arabicFirst: string; arabicLast: string }
  >;
  hadiths: EditionHadith[];
};

/** Parse one edition file (throws on shape drift). */
export function parseHadithEdition(
  collection: HadithCollection,
  language: "arabic" | "indonesian",
  json: unknown,
): HadithEdition {
  if (typeof json !== "object" || json === null) {
    throw new Error(`hadith source: ${collection}/${language} edition is not a JSON object`);
  }
  const root = json as {
    metadata?: {
      sections?: Record<string, string>;
      section_details?: Record<
        string,
        {
          hadithnumber_first?: string | number;
          hadithnumber_last?: string | number;
          arabicnumber_first?: string | number;
          arabicnumber_last?: string | number;
        }
      >;
    };
    hadiths?: unknown;
  };
  if (typeof root.metadata !== "object" || root.metadata === null) {
    throw new Error(`hadith source: ${collection}/${language} edition has no metadata`);
  }
  if (!Array.isArray(root.hadiths)) {
    throw new Error(`hadith source: ${collection}/${language} edition has no hadiths array`);
  }
  const sections = new Map<number, string>();
  for (const [k, title] of Object.entries(root.metadata.sections ?? {})) {
    sections.set(Number(k), String(title));
  }
  const sectionDetails = new Map<
    number,
    { first: string; last: string; arabicFirst: string; arabicLast: string }
  >();
  for (const [k, d] of Object.entries(root.metadata.section_details ?? {})) {
    sectionDetails.set(Number(k), {
      first: d.hadithnumber_first !== undefined ? String(d.hadithnumber_first) : "",
      last: d.hadithnumber_last !== undefined ? String(d.hadithnumber_last) : "",
      arabicFirst: d.arabicnumber_first !== undefined ? String(d.arabicnumber_first) : "",
      arabicLast: d.arabicnumber_last !== undefined ? String(d.arabicnumber_last) : "",
    });
  }
  const hadiths = root.hadiths.map((row): EditionHadith => {
    if (typeof row !== "object" || row === null) {
      throw new Error(`hadith source: ${collection}/${language} hadith row is not an object`);
    }
    const h = row as {
      hadithnumber?: unknown;
      arabicnumber?: unknown;
      text?: unknown;
      grades?: unknown;
      reference?: unknown;
    };
    const ref = h.reference as { book?: unknown; hadith?: unknown } | null | undefined;
    if (
      (typeof h.hadithnumber !== "string" && typeof h.hadithnumber !== "number") ||
      (h.arabicnumber !== undefined &&
        typeof h.arabicnumber !== "string" &&
        typeof h.arabicnumber !== "number") ||
      typeof h.text !== "string" ||
      !Array.isArray(h.grades) ||
      typeof ref !== "object" ||
      ref === null ||
      typeof ref.book !== "number"
    ) {
      throw new Error(
        `hadith source: ${collection}/${language} hadith row missing required fields`,
      );
    }
    const hadithnumber = String(h.hadithnumber);
    // muslim's book-0 rows lack arabicnumber — fall back to the edition's own hadithnumber.
    const arabicnumber = h.arabicnumber === undefined ? hadithnumber : String(h.arabicnumber);
    return {
      hadithnumber,
      arabicnumber,
      text: h.text,
      // Malformed grade entries are shape drift — throw, never silently discard source data.
      grades: h.grades.map((g): { name: string; grade: string } => {
        if (
          typeof g !== "object" ||
          g === null ||
          typeof (g as { name?: unknown }).name !== "string" ||
          typeof (g as { grade?: unknown }).grade !== "string"
        ) {
          throw new Error(
            `hadith source: ${collection}/${language} ${hadithnumber} has a malformed grade entry`,
          );
        }
        return g as { name: string; grade: string };
      }),
      reference: {
        book: ref.book,
        hadith: (ref.hadith as string | number | undefined) ?? hadithnumber,
      },
    };
  });
  return { collection, language, sections, sectionDetails, hadiths };
}

/**
 * Integrity gate: non-negative integer book numbers, non-empty hadith numbers, unique
 * (collection, hadithNo) keys, and exact per-collection counts when `expected` gives them.
 * Throws on the first violation — a truncated parse must fail loudly, never ingest
 * silently. Unmatched alignment entries are not gated here: they are counted upstream and
 * surfaced in the report (quarantine, not force-merge).
 */
export function assertHadithIntegrity(
  records: readonly HadithRecord[],
  expected?: Partial<Record<HadithCollection, number>>,
): void {
  const perCollection = new Map<HadithCollection, number>();
  const seen = new Set<string>();
  for (const r of records) {
    if (!HADITH_COLLECTIONS.includes(r.collection)) {
      throw new Error(`hadith integrity: unknown collection ${r.collection}`);
    }
    if (r.hadithNo.trim().length === 0) {
      throw new Error(`hadith integrity: ${r.collection} record with empty hadith number`);
    }
    if (!Number.isInteger(r.bookNo) || r.bookNo < 0) {
      throw new Error(
        `hadith integrity: ${r.collection} ${r.hadithNo} has invalid book number ${r.bookNo}`,
      );
    }
    if (r.textAr.trim().length === 0) {
      throw new Error(`hadith integrity: ${r.collection} ${r.hadithNo} has no Arabic text`);
    }
    const key = `${r.collection}:${r.hadithNo}`;
    if (seen.has(key)) {
      throw new Error(`hadith integrity: duplicate hadith ${key}`);
    }
    seen.add(key);
    perCollection.set(r.collection, (perCollection.get(r.collection) ?? 0) + 1);
  }
  if (expected !== undefined) {
    for (const [collection, count] of Object.entries(expected) as [HadithCollection, number][]) {
      if (perCollection.get(collection) !== count) {
        throw new Error(
          `hadith integrity: expected ${count} ${collection} hadith(s), got ${perCollection.get(collection) ?? 0}`,
        );
      }
    }
  }
}
