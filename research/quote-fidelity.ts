/**
 * Deterministic quote fidelity: every quoted span must be a normalised substring of the
 * chunk it cites. This is the tier-0 check that carries the citation gate — see
 * docs/research/answer-attribution.md §3 and experiments.md E3/E4 for why the model tier
 * may not gate support.
 *
 * Research artefact: not wired into the eval package yet.
 */

/** Arabic diacritics, tatweel, and Quranic annotation marks. */
const DIACRITICS = /[\u064B-\u0652\u0670\u06D6-\u06ED\u0640]/g;

/** Orthographic variants that must not decide whether a quote is faithful. */
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

/**
 * Fold everything that must not matter — diacritics, alef/ya/ta-marbuta variants,
 * punctuation and case — so a faithful quote is never rejected over orthography.
 */
export function normalise(text: string): string {
  return (
    text
      .replace(DIACRITICS, "")
      .replace(/[أإآىةؤئ]/gu, (character) => FOLD[character] ?? character)
      .toLowerCase()
      // Indonesian writes the divine epithets both ways: "Maha Perkasa" and "Mahaperkasa".
      .replace(/\bmaha\s+/gu, "maha")
      .replace(/[^\p{L}\p{N}\u0600-\u06FF ]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

/**
 * True when every fragment of the quote appears, in order, inside the chunk.
 *
 * The split happens **before** normalisation: normalising first erases the ellipsis and
 * turns an elided quote into one contiguous string no chunk contains (experiments.md E3).
 */
export function quoteIsFaithful(quote: string, chunk: string): boolean {
  const chunkText = normalise(chunk);
  const whole = normalise(quote);
  if (whole.length === 0) return false;
  if (chunkText.includes(whole)) return true;
  const fragments = quote
    .split(ELLIPSIS)
    .map(normalise)
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

/** A quoted span as the answer rendered it, with where it ends in the answer. */
export type QuotedSpan = { readonly quote: string; readonly end: number };

/**
 * Extract quoted spans without pairing a closing mark as if it opened a quote.
 *
 * Typographic quotes are unambiguous and are taken first. Straight quotes are ambiguous in
 * running text — a model that writes `"a" [1] dan "b" [2]` has four of them — so the spans
 * already taken are blanked, and what remains is split on the straight mark where the odd
 * segments are the quoted ones. A quote must be at least four characters; shorter spans are
 * treated as emphasis and skipped rather than checked.
 */
export function quotedSpans(answer: string): QuotedSpan[] {
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
  const parts = blanked.split('"');
  for (const [index, part] of parts.entries()) {
    if (index % 2 === 1 && part.trim().length >= 8) {
      spans.push({ quote: part, end: position + part.length + 1 });
    }
    position += part.length + 1;
  }
  return spans;
}

export type Citation = { label: string; text: string };

export type QuoteVerdict =
  | { quote: string; status: "faithful"; citation: string }
  | {
      quote: string;
      status: "unverifiable";
      reason: "no-citations" | "no-quote-in-citation" | "empty-quote";
    };

/**
 * Check every quoted span in an answer against the chunks the answer cites.
 *
 * A quote is faithful when it appears in **at least one** cited chunk; when the answer
 * cites nothing and quotes something, the quote is unverifiable rather than faithful.
 */
export function checkAnswer(answer: string, citations: readonly Citation[]): QuoteVerdict[] {
  const quotes = quotedSpans(answer).map((span) => span.quote);
  const verdicts: QuoteVerdict[] = [];
  for (const quote of quotes) {
    const trimmed = quote.trim();
    if (normalise(trimmed).length === 0) {
      verdicts.push({ quote: trimmed, status: "unverifiable", reason: "empty-quote" });
      continue;
    }
    const match = citations.find((citation) => quoteIsFaithful(trimmed, citation.text));
    if (match) {
      verdicts.push({ quote: trimmed, status: "faithful", citation: match.label });
    } else {
      verdicts.push({
        quote: trimmed,
        status: "unverifiable",
        reason: citations.length === 0 ? "no-citations" : "no-quote-in-citation",
      });
    }
  }
  return verdicts;
}
