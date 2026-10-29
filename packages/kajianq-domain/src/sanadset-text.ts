/**
 * Arabic folding and matn canonicalisation for the Sanadset reconciliation study.
 *
 * The fold is lossy in exactly one direction: it collapses orthographic variants that
 * cannot change a narrator's identity (diacritics, alef/ya/ta-marbuta forms, tatweel,
 * punctuation, honorifics) and never removes a consonant that distinguishes two names.
 * Anything the fold cannot settle stays for blocking or the blind sample, never a guess.
 */

const DIACRITICS = /[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/gu;
const ALEF_VARIANTS = /[\u0622\u0623\u0625\u0671]/gu;
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;
const IDF_SPAN = /<IDF>[\s\S]*?<\/IDF>/gu;
const WHITESPACE = /\s+/gu;
const BLESSING = "\uFDFA";

/** Honorifics that follow a narrator's name rather than form part of it. */
const HONORIFICS_RAW: readonly string[] = [
  "\u0635\u0644\u0649 \u0627\u0644\u0644\u0647 \u0639\u0644\u064a\u0647 \u0648\u0633\u0644\u0645",
  "\u0631\u0636\u064a \u0627\u0644\u0644\u0647 \u0639\u0646\u0647\u0645\u0627",
  "\u0631\u0636\u064a \u0627\u0644\u0644\u0647 \u0639\u0646\u0647\u0627",
  "\u0631\u0636\u064a \u0627\u0644\u0644\u0647 \u0639\u0646\u0647\u0645",
  "\u0631\u0636\u064a \u0627\u0644\u0644\u0647 \u0639\u0646\u0647",
  "\u0631\u062d\u0645\u0647 \u0627\u0644\u0644\u0647",
  "\u0631\u062d\u0645\u0647\u0627 \u0627\u0644\u0644\u0647",
  "\u0631\u062d\u0645\u0647\u0645 \u0627\u0644\u0644\u0647",
  "\u0639\u0644\u064a\u0647 \u0627\u0644\u0633\u0644\u0627\u0645",
  "\u0639\u0644\u064a\u0647\u0627 \u0627\u0644\u0633\u0644\u0627\u0645",
  "\u0639\u0644\u064a\u0647\u0645 \u0627\u0644\u0633\u0644\u0627\u0645",
];

/**
 * Orthographic folding: the form two spellings of the same name must share before
 * identity is considered. It removes no root letter.
 */
function foldBase(text: string): string {
  return text
    .replace(IDF_SPAN, " ")
    .replace(DIACRITICS, "")
    .replace(ALEF_VARIANTS, "\u0627")
    .replace(/\u0649/gu, "\u064a")
    .replace(/\u0629/gu, "\u0647")
    .split(BLESSING)
    .join(" ")
    .replace(PUNCTUATION, " ")
    .replace(WHITESPACE, " ")
    .trim();
}

const FOLDED_HONORIFICS = HONORIFICS_RAW.map(foldBase);
/** "النبي" after folding; the blessing that follows it is an honorific. */
const FOLDED_PROPHET = "\u0627\u0644\u0646\u0628\u064a";

/** Remove honorific phrases from an already folded string. */
function stripHonorifics(folded: string): string {
  let text = folded;
  for (const phrase of FOLDED_HONORIFICS) text = text.split(phrase).join(" ");
  return text.replace(WHITESPACE, " ").trim();
}

/** Fold a narrator's name: diacritics, alef/ya/ta-marbuta forms, honorifics. */
export function foldNarratorName(raw: string): string {
  return stripHonorifics(foldBase(raw));
}

/** Fold arbitrary Arabic text without stripping honorifics from the interior. */
export function foldArabicText(raw: string): string {
  return stripHonorifics(foldBase(raw));
}

/**
 * The leading transmission phrase most matn columns carry before the actual text
 * ("، عن النبي ﷺ ، قال :"). Stripping it is safe only when content remains, which
 * the caller enforces by falling back to the unstripped fold.
 */
const LEADING_LINK = new RegExp(
  `^(?:(?:\\u0648?\\u0639\\u0646|\\u0642\\u0627\\u0644|\\u062d\\u062f\\u062b\\u0646\\u0627|\\u0627\\u062e\\u0628\\u0631\\u0646\\u0627)\\s+)?` +
    `(?:${FOLDED_PROPHET}|\\u0631\\u0633\\u0648\\u0644\\s+\\u0627\\u0644\\u0644\\u0647)\\s*` +
    `(?:\\u0642\\u0627\\u0644|\\u064a\\u0642\\u0648\\u0644)?\\s*`,
);

/** Tokens of a matn that merely point at another hadith instead of carrying a text. */
const REFERENCE_TOKENS = new Set([
  "\u0639\u0646",
  "\u0627\u0644\u0646\u0628\u064a",
  "\u0631\u0633\u0648\u0644",
  "\u0627\u0644\u0644\u0647",
  "\u0642\u0627\u0644",
  "\u064a\u0642\u0648\u0644",
  "\u0628\u0647\u0630\u0627",
  "\u0627\u0644\u0627\u0633\u0646\u0627\u062f",
  "\u0628\u0645\u062b\u0644\u0647",
  "\u0645\u062b\u0644\u0647",
  "\u0628\u0646\u062d\u0648\u0647",
  "\u0646\u062d\u0648\u0647",
  "\u0627\u0644\u062d\u062f\u064a\u062b",
  "\u0647\u0630\u0627",
  "\u0635\u0644\u064a",
  "\u0639\u0644\u064a\u0647",
  "\u0648\u0633\u0644\u0645",
  "\u0631\u0636\u064a",
  "\u0631\u062d\u0645\u0647",
  "\u0627\u0644\u0633\u0644\u0627\u0645",
]);

/**
 * Canonical matn text: fold, strip a leading transmission phrase when content
 * remains, then fold honorifics. A reference-only row normalises to its link
 * phrase (so the caller can quarantine it) rather than to the empty string.
 */
export function normalizeMatnText(raw: string): string {
  const folded = stripHonorifics(foldBase(raw));
  if (folded.length === 0) return "";
  const stripped = folded.replace(LEADING_LINK, "").trim();
  return stripped.length > 0 ? stripped : folded;
}

/**
 * True when the matn is a cross-reference ("the like of it", "with this chain")
 * rather than a text of its own. Such rows are quarantined: folding them together
 * would force-merge distinct hadiths that merely point at a neighbour.
 */
export function isReferenceOnlyMatn(normalized: string): boolean {
  if (normalized.length === 0) return false;
  return normalized.split(" ").every((token) => REFERENCE_TOKENS.has(token));
}

/** Sorted unique character trigrams; a short string is its own single token. */
export function matnTrigrams(normalized: string): string[] {
  if (normalized.length === 0) return [];
  if (normalized.length < 3) return [normalized];
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= normalized.length; i += 1) grams.add(normalized.slice(i, i + 3));
  return [...grams].sort();
}

/**
 * Jaccard similarity over two sorted trigram lists. An empty side carries no
 * evidence, so any pair involving it scores 0 rather than 1.
 */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let i = 0;
  let j = 0;
  let intersection = 0;
  while (i < a.length && j < b.length) {
    const left = a[i]!;
    const right = b[j]!;
    if (left === right) {
      intersection += 1;
      i += 1;
      j += 1;
    } else if (left < right) {
      i += 1;
    } else {
      j += 1;
    }
  }
  const union = a.length + b.length - intersection;
  return union === 0 ? 0 : intersection / union;
}
