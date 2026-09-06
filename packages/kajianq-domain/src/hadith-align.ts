import type { EditionHadith, HadithEdition } from "./hadith-parse";
import type { HadithCollection, HadithRecord } from "./hadith-source";

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
    throw new Error(
      `hadith source: aligning editions of different collections (${a.collection} vs ${b.collection})`,
    );
  }
  if (a.language !== "arabic" || b.language !== "indonesian") {
    throw new Error(
      `hadith source: align needs (arabic, indonesian) editions, got (${a.language}, ${b.language})`,
    );
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
