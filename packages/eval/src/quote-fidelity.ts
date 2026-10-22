import type { QuoteEquivalence } from "./harness-types";

/**
 * Quote fidelity: does each quoted span in an answer appear in a chunk the answer cites?
 *
 * A citation can be perfectly valid — the required address is present in the answer — while the
 * quotation beside it is the model's own paraphrase, which a reader cannot check. This scorer
 * answers the narrower, deterministic question: are the words inside quotation marks actually
 * the words of a cited chunk?
 *
 * It verifies **existence, not attribution**: a quote found in any cited chunk passes. Resolving
 * which citation a span points at needs the answer's inline label positions; a stricter scorer
 * can refine later without changing this contract.
 *
 * The fold here is deliberately script-generic — case, punctuation, combining marks and a
 * script's own orthographic variants. Equivalences that belong to a particular language or
 * corpus arrive through `QuoteEquivalence` entries from the caller.
 */

/** Any combining mark: diacritics, annotation marks and accent marks. */
const COMBINING_MARKS = /\p{M}+/gu;

/** Tatweel/kashida elongates a word but carries no word of its own. */
const TATWEEL = /\u0640/gu;

/** Arabic-script variants no spelling difference may decide a quote: alef wasla, alef
 * maksura and ta marbuta. The hamza- and maddah-carrying letters fold through the
 * compatibility decomposition in `normaliseQuote`, which turns each into its carrier
 * plus a mark. */
const SCRIPT_VARIANTS = /[ٱىة]/gu;
const SCRIPT_FOLD: Readonly<Record<string, string>> = { ٱ: "ا", ى: "ي", ة: "ه" };

/** Everything that is not a letter or a number separates words. */
const WORD_SEPARATOR = /[^\p{L}\p{N}]+/gu;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const WHITESPACE_RUN = /\s+/gu;

const ELLIPSIS = /\.\.\.|…/u;

/** The shortest quoted span that counts as a citation claim; shorter spans are emphasis or a
 * quoted term, and scoring them would let typography decide the metric. */
export const MIN_QUOTE_LENGTH = 8;

/** A typographic quotation of at least {@link MIN_QUOTE_LENGTH} characters. */
const TYPOGRAPHIC_QUOTE = new RegExp(`“([^”]{${MIN_QUOTE_LENGTH},})”`, "gu");

/**
 * Fold everything that must not decide a quote — case, punctuation, combining marks, and a
 * script's orthographic variants — then apply the caller's own equivalences (they see the
 * folded, lower-cased text; give a pattern the `g` flag when it must apply repeatedly).
 */
export function normaliseQuote(
  text: string,
  equivalences: readonly QuoteEquivalence[] = [],
): string {
  let normalised = text
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(TATWEEL, "")
    .toLowerCase()
    .replace(SCRIPT_VARIANTS, (character) => SCRIPT_FOLD[character] ?? character)
    .replace(WORD_SEPARATOR, " ")
    .trim();
  for (const { pattern, replacement } of equivalences) {
    normalised = normalised.replace(pattern, replacement);
  }
  return normalised.replace(WHITESPACE_RUN, " ").trim();
}

/**
 * The first occurrence of `needle` at or after `from` that does not begin or end inside a
 * word. A match boundary is what stops a quote from splicing onto a longer word: `nyucikan
 * harta` must not pass inside `menyucikan harta`.
 */
function indexOfAligned(text: string, needle: string, from = 0): number {
  let at = text.indexOf(needle, from);
  while (at >= 0) {
    const before = at === 0 ? "" : text[at - 1]!;
    const after = text[at + needle.length] ?? "";
    if (!WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after)) return at;
    at = text.indexOf(needle, at + 1);
  }
  return -1;
}

/**
 * True when every fragment of the quote appears, in order and on word boundaries, inside the
 * chunk.
 *
 * The split happens **before** normalisation: normalising first erases the ellipsis and turns
 * an elided quote into one contiguous string no chunk contains.
 */
export function quoteAppearsIn(
  quote: string,
  chunk: string,
  equivalences: readonly QuoteEquivalence[] = [],
): boolean {
  const chunkText = normaliseQuote(chunk, equivalences);
  const whole = normaliseQuote(quote, equivalences);
  if (whole.length === 0) return false;
  if (indexOfAligned(chunkText, whole) >= 0) return true;
  const fragments = quote
    .split(ELLIPSIS)
    .map((fragment) => normaliseQuote(fragment, equivalences))
    .filter((fragment) => fragment.length > 0);
  if (fragments.length < 2) return false;
  let position = 0;
  for (const fragment of fragments) {
    const found = indexOfAligned(chunkText, fragment, position);
    if (found < 0) return false;
    position = found + fragment.length;
  }
  return true;
}

/**
 * Extract quoted spans without pairing a closing mark as if it opened a quote.
 *
 * Typographic quotes are unambiguous and are taken first. Straight quotes are ambiguous in
 * running text — `"a" and "b"` has four — so the spans already taken are blanked, and the rest
 * is split on the straight mark, where the odd segments are the quoted ones. An unterminated
 * trailing segment is not a quotation and is dropped rather than scored. A span shorter than
 * {@link MIN_QUOTE_LENGTH} is emphasis or a quoted term, not a citation claim, and is skipped.
 */
export function quotedSpansIn(answer: string): string[] {
  const spans: string[] = [];
  const taken: Array<[number, number]> = [];
  for (const match of answer.matchAll(TYPOGRAPHIC_QUOTE)) {
    const start = match.index ?? 0;
    spans.push(match[1] ?? "");
    taken.push([start, start + match[0].length]);
  }
  // Blank by UTF-16 slicing: `match.index` and `match[0].length` count UTF-16 code units, so a
  // code-point walk would drift after an astral character and could blank the next opener.
  let blanked = answer;
  for (const [start, end] of taken) {
    blanked = blanked.slice(0, start) + "\u0000".repeat(end - start) + blanked.slice(end);
  }
  const quoteCount = blanked.split('"').length - 1;
  for (const [index, part] of blanked.split('"').entries()) {
    if (index % 2 === 1 && index < quoteCount && part.trim().length >= MIN_QUOTE_LENGTH) {
      spans.push(part);
    }
  }
  return spans;
}

export type QuoteAudit = {
  /** Quoted spans found in the answer. */
  readonly quoted: number;
  /** Spans that appear, in order, in at least one cited chunk. */
  readonly verified: number;
  /** The spans that appear in none, as the answer wrote them. */
  readonly unverifiable: readonly string[];
};

/**
 * Audit every quoted span in an answer against the text of the chunks the answer cites.
 *
 * An answer with no quotations audits to zero spans, not to a perfect score: the caller decides
 * whether "quoted nothing" is a pass, and a refusal that quotes nothing must not read as
 * verified evidence.
 */
export function auditQuotes(
  answerText: string,
  citedTexts: readonly string[],
  equivalences: readonly QuoteEquivalence[] = [],
): QuoteAudit {
  const unverifiable: string[] = [];
  let quoted = 0;
  let verified = 0;
  for (const span of quotedSpansIn(answerText)) {
    quoted += 1;
    if (citedTexts.some((text) => quoteAppearsIn(span, text, equivalences))) verified += 1;
    else unverifiable.push(span);
  }
  return { quoted, verified, unverifiable };
}
