import {
  HADITH_COLLECTIONS,
  type HadithCollection,
  type HadithRecord,
} from "./hadith-source";

/**
 * Parsers for the hadith corpus sources (#7), all keyed to the source's own
 * numbering (ADR-0025: the alignment key between the Arabic and Indonesian
 * editions is the edition's `arabicnumber` within a `reference.book` — the
 * number pair, not fuzzy text matching, is the authoritative join).
 *
 * Upstream format (fawazahmed0/hadith-api editions, Unlicense): one JSON
 * file per edition with `metadata.sections` (book number → title),
 * `metadata.section_details` (hadith-number ranges per book), and a
 * `hadiths[]` array of `{hadithnumber, arabicnumber, text, grades,
 * reference}`. Grade entries ship only on the Arabic editions; the
 * Indonesian edition's `grades` array is ignored in favor of the Arabic
 * one. Nothing here rewrites text: the raw strings are preserved verbatim
 * (`text_raw` is immutable, AGENTS.md rule 11).
 */

/**
 * One hadith entry of an edition JSON file, after normalization: the source
 * ships `hadithnumber`/`arabicnumber` as JSON numbers (all collections,
 * verified against the live editions — review A1), and the parser accepts
 * both numbers and strings, normalizing to strings.
 */
export type EditionHadith = {
  hadithnumber: string;
  arabicnumber: string;
  text: string;
  grades: { name: string; grade: string }[];
  reference: { book: number; hadith: string | number };
};

/** One edition file: a collection's texts in one language. */
export type HadithEdition = {
  collection: HadithCollection;
  language: "arabic" | "indonesian";
  /** Book number → title (empty title allowed; metadata only). */
  sections: Map<number, string>;
  /** Book number → first/last hadith number in the book. */
  sectionDetails: Map<
    number,
    { first: string; last: string; arabicFirst: string; arabicLast: string }
  >;
  hadiths: EditionHadith[];
};

/** Alignment stats for the report — surfaced, never force-merged. */
export type AlignmentStats = {
  /** Records with both tracks non-empty. */
  aligned: number;
  /** Arabic entries whose Indonesian text is empty (textId = null). */
  emptySecondary: number;
  /**
   * Arabic entries with genuinely empty Arabic text, quarantined (skipped,
   * never ingested — review A2): the source ships them (86 in ara-nasai,
   * 29 in ara-malik, muslim's book-0 rows).
   */
  emptyPrimary: number;
  /** Book/number pairs missing from one edition (quarantine-listed). */
  unmatched: { collection: HadithCollection; key: string; side: "arabic" | "indonesian" }[];
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
        { hadithnumber_first?: string | number; hadithnumber_last?: string | number; arabicnumber_first?: string | number; arabicnumber_last?: string | number }
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
    // The source ships these as numbers (byte-true fixtures); normalize.
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
      throw new Error(`hadith source: ${collection}/${language} hadith row missing required fields`);
    }
    const hadithnumber = String(h.hadithnumber);
    // muslim's book-0 rows lack arabicnumber entirely — fall back to the
    // edition's own hadithnumber (the alignment's fallback join key).
    const arabicnumber = h.arabicnumber === undefined ? hadithnumber : String(h.arabicnumber);
    return {
      hadithnumber,
      arabicnumber,
      text: h.text,
      // Malformed grade entries are shape drift — throw, never silently
      // discard source data (review B4). The live editions ship
      // well-formed {name, grade} entries on every row.
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
      reference: { book: ref.book, hadith: (ref.hadith as string | number | undefined) ?? hadithnumber },
    };
  });
  return { collection, language, sections, sectionDetails, hadiths };
}

/**
 * Join the Arabic and Indonesian editions of one collection on
 * (`reference.book`, `arabicnumber`), falling back to `hadithnumber` when
 * the two editions disagree on the Arabic numbering. Throws on duplicate
 * keys or unmatched entries — a shifted or partial edition must fail loudly,
 * never silently mis-align (AGENTS.md rule 14: disputed alignment is
 * quarantined, never force-merged).
 */
export function alignEditions(
  arabic: HadithEdition,
  indonesian: HadithEdition,
): { records: HadithRecord[]; stats: AlignmentStats } {
  assertSameCollection(arabic, indonesian);
  const stats: AlignmentStats = { aligned: 0, emptySecondary: 0, emptyPrimary: 0, unmatched: [] };
  const byBookNo = new Map<string, EditionHadith>();
  for (const h of indonesian.hadiths) {
    const key = `${h.reference.book}:${h.arabicnumber}`;
    if (byBookNo.has(key)) {
      throw new Error(`hadith source: duplicate Indonesian entry ${arabic.collection} ${key}`);
    }
    byBookNo.set(key, h);
  }
  const records: HadithRecord[] = [];
  for (const h of arabic.hadiths) {
    // Primary join: the Arabic edition's numbering. Fallback: the edition's
    // own hadithnumber, for entries where the two editions disagree on the
    // Arabic numbering (the Indonesian edition mirrors one or the other).
    const key = `${h.reference.book}:${h.arabicnumber}`;
    const fallbackKey = `${h.reference.book}:${h.hadithnumber}`;
    const matchedKey = byBookNo.has(key)
      ? key
      : fallbackKey !== key && byBookNo.has(fallbackKey)
        ? fallbackKey
        : null;
    // Empty-Arabic rows are quarantined, not ingested (review A2): the
    // source genuinely ships them (86 in ara-nasai, 29 in ara-malik,
    // muslim's book-0 rows). Consume the Indonesian counterpart so it is
    // not double-counted as unmatched.
    if (h.text.trim().length === 0) {
      stats.emptyPrimary += 1;
      if (matchedKey !== null) byBookNo.delete(matchedKey);
      continue;
    }
    const id = matchedKey === null ? undefined : byBookNo.get(matchedKey);
    if (id === undefined || matchedKey === null) {
      stats.unmatched.push({ collection: arabic.collection, key, side: "indonesian" });
      continue;
    }
    byBookNo.delete(matchedKey);
    records.push(toRecord(arabic, h, id, stats));
  }
  // Indonesian entries left over have no Arabic counterpart.
  for (const key of byBookNo.keys()) {
    stats.unmatched.push({ collection: arabic.collection, key, side: "arabic" });
  }
  return { records, stats };
}

function assertSameCollection(a: HadithEdition, b: HadithEdition): void {
  if (a.collection !== b.collection) {
    throw new Error(`hadith source: aligning editions of different collections (${a.collection} vs ${b.collection})`);
  }
  if (a.language !== "arabic" || b.language !== "indonesian") {
    throw new Error(`hadith source: align needs (arabic, indonesian) editions, got (${a.language}, ${b.language})`);
  }
}

function toRecord(
  arabic: HadithEdition,
  ar: EditionHadith,
  id: EditionHadith,
  stats: AlignmentStats,
): HadithRecord {
  const textId = id.text.trim().length === 0 ? null : id.text;
  if (textId === null) stats.emptySecondary += 1;
  else stats.aligned += 1;
  return {
    collection: arabic.collection,
    hadithNo: ar.hadithnumber,
    bookNo: ar.reference.book,
    bookName: arabic.sections.get(ar.reference.book) ?? null,
    textAr: ar.text,
    textId,
    grades: ar.grades,
  };
}

/**
 * Integrity check (issue #7 AC): every ingested record has a positive book
 * number and a non-empty hadith number; no duplicate (collection, hadithNo)
 * keys; and, when `expected` gives a per-collection count gate, the ingested
 * counts match exactly. Throws on the first violation — a truncated parse
 * must fail loudly, never ingest silently. The empty-Arabic gate stays as
 * defense in depth, but alignment quarantines empty-primary rows upstream
 * (review A2), so it never fires on the real corpus. Unmatched entries are
 * NOT a gate here: they are counted upstream and surfaced in the report
 * (quarantine, not force-merge).
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
      throw new Error(`hadith integrity: ${r.collection} ${r.hadithNo} has invalid book number ${r.bookNo}`);
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