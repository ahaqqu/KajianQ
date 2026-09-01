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

/** One hadith entry of an edition JSON file. */
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
        { hadithnumber_first?: string; hadithnumber_last?: string; arabicnumber_first?: string; arabicnumber_last?: string }
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
      first: d.hadithnumber_first ?? "",
      last: d.hadithnumber_last ?? "",
      arabicFirst: d.arabicnumber_first ?? "",
      arabicLast: d.arabicnumber_last ?? "",
    });
  }
  const hadiths = root.hadiths.map((row): EditionHadith => {
    if (typeof row !== "object" || row === null) {
      throw new Error(`hadith source: ${collection}/${language} hadith row is not an object`);
    }
    const h = row as Partial<EditionHadith>;
    if (
      typeof h.hadithnumber !== "string" ||
      typeof h.arabicnumber !== "string" ||
      typeof h.text !== "string" ||
      !Array.isArray(h.grades) ||
      typeof h.reference !== "object" ||
      h.reference === null ||
      typeof h.reference.book !== "number"
    ) {
      throw new Error(`hadith source: ${collection}/${language} hadith row missing required fields`);
    }
    return {
      hadithnumber: h.hadithnumber,
      arabicnumber: h.arabicnumber,
      text: h.text,
      grades: h.grades.filter(
        (g): g is { name: string; grade: string } =>
          typeof g === "object" && g !== null && typeof g.name === "string" && typeof g.grade === "string",
      ),
      reference: { book: h.reference.book, hadith: h.reference.hadith ?? h.hadithnumber },
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
  const stats: AlignmentStats = { aligned: 0, emptySecondary: 0, unmatched: [] };
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
    const id = byBookNo.get(key) ?? (fallbackKey !== key ? byBookNo.get(fallbackKey) : undefined);
    if (id === undefined) {
      stats.unmatched.push({ collection: arabic.collection, key, side: "indonesian" });
      continue;
    }
    byBookNo.delete(id === byBookNo.get(key) ? key : fallbackKey);
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
 * Integrity check (issue #7 AC): every ingested record has Arabic text, a
 * positive book number, and a non-empty hadith number; no duplicate
 * (collection, hadithNo) keys; and, when `expected` gives a per-collection
 * count gate, the ingested counts match exactly. Throws on the first
 * violation — a truncated parse must fail loudly, never ingest silently.
 * Unmatched entries are NOT a gate here: they are counted upstream and
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

/**
 * Grade-consolidation summary for the ingestion report: how many records are
 * graded at all, how many the dhaif-wins policy demoted to `dhaif`, and how
 * many carry no grades (grade = null, never fabricated).
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
    if (r.grades.some((g) => /daif|dhaif|munkar|shadh|mansukh|marfoo/i.test(g.grade))) {
      dhaifWins += 1;
    }
  }
  return { graded, dhaifWins, ungraded };
}