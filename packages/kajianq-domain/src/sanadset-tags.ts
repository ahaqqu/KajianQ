/**
 * Reading the `<SANAD>` / `<NAR>` / `<MATN>` markup a Sanadset row carries, and deciding
 * whether it can be read linearly at all.
 *
 * The markup is what the archive's own extractor emitted, and it is not always
 * well-formed: a row may open a `<MATN>` inside a `<MATN>`, or open a tag it never
 * closes. A row whose tag structure disagrees with itself cannot be split into chain and
 * text by any span reader, so the study quarantines it instead of trusting a guess.
 */

const MATN_SPAN = /<MATN>[\s\S]*?<\/MATN>/gu;
const OPEN_MATN = /<MATN>/gu;
const CLOSE_MATN = /<\/MATN>/gu;
const OPEN_SANAD = /<SANAD>/gu;
const CLOSE_SANAD = /<\/SANAD>/gu;

/** True when an opening `<SANAD>` appears inside a `<MATN>` span. */
export function hasNestedSanad(hadith: string): boolean {
  for (const match of hadith.matchAll(MATN_SPAN)) {
    if (match[0].includes("<SANAD>")) return true;
  }
  return false;
}

function countMatches(pattern: RegExp, text: string): number {
  return [...text.matchAll(pattern)].length;
}

/** True when the open and close counts of either tag disagree. */
export function hasUnbalancedTags(hadith: string): boolean {
  return (
    countMatches(OPEN_MATN, hadith) !== countMatches(CLOSE_MATN, hadith) ||
    countMatches(OPEN_SANAD, hadith) !== countMatches(CLOSE_SANAD, hadith)
  );
}

/** The archive's placeholder for a record with no chain; never a narrator list. */
export function isNoSanad(raw: string): boolean {
  const text = raw.trim();
  return text.length === 0 || text === "No SANAD";
}
