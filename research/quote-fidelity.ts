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
  return text
    .replace(DIACRITICS, "")
    .replace(/[أإآىةؤئ]/gu, (character) => FOLD[character] ?? character)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\u0600-\u06FF ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
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

/** A quoted span as the answer rendered it: straight or typographic quotes. */
const QUOTED = /[“"]([^”"]{8,})[”"]/gu;

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
  const quotes = [...answer.matchAll(QUOTED)].map((match) => match[1] ?? "");
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
