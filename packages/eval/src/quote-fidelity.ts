/**
 * Quote fidelity: does each quoted span in an answer appear in a chunk the answer cites?
 *
 * A citation can be perfectly valid — the required address is present in the answer — while the
 * quotation beside it is the model's own paraphrase, which a reader cannot check. This scorer
 * answers the narrower, deterministic question: are the words inside quotation marks actually
 * the words of a cited chunk?
 *
 * It verifies **existence, not attribution**: a quote found in any cited chunk passes. The
 * alternative — resolving which citation a span points at — needs the answer's inline label
 * positions, and the measured misattribution rate is low enough that the simpler check is the
 * honest one to start with; a stricter scorer can refine later without changing this contract.
 *
 * No model is involved. Experiments show a model tier cannot gate support
 * (`docs/research/experiments.md` E4), and that this check is precise (E3).
 */

/** Diacritics, tatweel, and the annotation marks a script may carry. */
const DIACRITICS = /[\u064B-\u0652\u0670\u06D6-\u06ED\u0640]/gu;

/** Orthographic variants in the scripts this corpus carries that must not decide a quote. */
const FOLD: Readonly<Record<string, string>> = {
  أ: "ا",
  إ: "ا",
  آ: "ا",
  ى: "ي",
  ة: "ه",
  ؤ: "و",
  ئ: "ي",
};

const ELLIPSIS = /\.\.\.|…/u;

/** A quoted span as the answer rendered it, and where it ends. */
export type QuotedSpan = { readonly quote: string; readonly end: number };

/**
 * Fold everything that must not matter — diacritics, alef/ya/ta-marbuta variants,
 * punctuation, case, and the space Indonesian puts inside a divine epithet ("Maha Perkasa"
 * and "Mahaperkasa" are the same words).
 */
export function normaliseQuote(text: string): string {
  return text
    .replace(DIACRITICS, "")
    .replace(/[أإآىةؤئ]/gu, (character) => FOLD[character] ?? character)
    .toLowerCase()
    .replace(/\bmaha\s+/gu, "maha")
    .replace(/[^\p{L}\p{N}\u0600-\u06FF ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * True when every fragment of the quote appears, in order, inside the chunk.
 *
 * The split happens **before** normalisation: normalising first erases the ellipsis and turns
 * an elided quote into one contiguous string no chunk contains.
 */
export function quoteAppearsIn(quote: string, chunk: string): boolean {
  const chunkText = normaliseQuote(chunk);
  const whole = normaliseQuote(quote);
  if (whole.length === 0) return false;
  if (chunkText.includes(whole)) return true;
  const fragments = quote
    .split(ELLIPSIS)
    .map(normaliseQuote)
    .filter((fragment) => fragment.length > 0);
  if (fragments.length < 2) return false;
  let position = 0;
  for (const fragment of fragments) {
    const found = chunkText.indexOf(fragment, position);
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
 * is split on the straight mark, where the odd segments are the quoted ones. A span shorter
 * than eight characters is emphasis or a quoted term, not a citation claim, and is skipped.
 */
export function quotedSpansIn(answer: string): QuotedSpan[] {
  const spans: QuotedSpan[] = [];
  const taken: Array<[number, number]> = [];
  for (const match of answer.matchAll(/“([^”]{8,})”/gu)) {
    const start = match.index ?? 0;
    spans.push({ quote: match[1] ?? "", end: start + match[0].length });
    taken.push([start, start + match[0].length]);
  }
  const blanked = [...answer]
    .map((character, index) =>
      taken.some(([start, end]) => index >= start && index < end) ? "\u0000" : character,
    )
    .join("");
  let position = 0;
  for (const [index, part] of blanked.split('"').entries()) {
    if (index % 2 === 1 && part.trim().length >= 8) {
      spans.push({ quote: part, end: position + part.length + 1 });
    }
    position += part.length + 1;
  }
  return spans;
}

/** Which chunk texts an answer offers to check against. */
export type CitedText = { readonly label: string; readonly text: string };

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
export function auditQuotes(answerText: string, cited: readonly CitedText[]): QuoteAudit {
  const unverifiable: string[] = [];
  let quoted = 0;
  let verified = 0;
  for (const span of quotedSpansIn(answerText)) {
    quoted += 1;
    if (cited.some((citation) => quoteAppearsIn(span.quote, citation.text))) verified += 1;
    else unverifiable.push(span.quote);
  }
  return { quoted, verified, unverifiable };
}
