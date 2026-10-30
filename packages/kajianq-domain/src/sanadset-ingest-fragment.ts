/**
 * The guards that keep a containment score from attaching a fragment to a narration,
 * and the evidence they measure.
 *
 * A trigram-containment score is a candidate signal, not a target: a one-word formula,
 * a short common phrase, a matn split across the narration, and a matn quoted inside a
 * much longer text all put most of the matn's trigrams in the child. The guards below
 * turn that relation into a text relation before a target is claimed: the matn must be a
 * text (enough distinct tokens and characters), most of its tokens must occur in the
 * child, those tokens must sit in a window close to the matn's own length, and the
 * narration must not be many times longer.
 *
 * `containmentRefusal` reports the first failed test, in the order above, so a
 * quarantine row names the measurement that actually held the group back.
 */

/** A fuzzy match needs at least this many distinct matn tokens to be a report. */
export const MIN_CONTAINMENT_TOKENS = 4;

/** And at least this many normalized characters, so a short formula is not a report. */
export const MIN_CONTAINMENT_CHARS = 16;

/** The share of the matn's distinct tokens that must occur in the stored child. */
export const MIN_TOKEN_COVERAGE = 0.8;

/**
 * The matched tokens must sit inside a candidate window at most this many times
 * the matn's distinct-token count: a text whose words are scattered across the
 * narration is quoting the matn's vocabulary, not carrying the matn.
 */
export const MAX_MATCH_WINDOW_RATIO = 2.5;

/**
 * The stored narration may be at most this many times the matn's normalized
 * characters. The matn plus an isnad is the intended relation; a narration many
 * times longer is a different report that happens to contain the matn.
 */
export const MAX_NARRATION_MATN_CHAR_RATIO = 8;

/** The part of a stored child the guard functions read. */
export type EvidenceChild = {
  readonly normalized: string;
  readonly tokenSequence: readonly string[];
  readonly tokenSet: ReadonlySet<string>;
};

/** The relation between a matn and one candidate, beyond the trigram score. */
type ContainmentEvidence = {
  readonly tokenCoverage: number;
  readonly windowRatio: number;
};

/** The folded tokens of a normalized text in text order; repeats are kept. */
export function tokenSequence(normalized: string): string[] {
  if (normalized === "") return [];
  return normalized.split(" ").filter((token) => token !== "");
}

/** The distinct folded tokens of a normalized text, in text order. */
export function tokensOf(normalized: string): string[] {
  return [...new Set(tokenSequence(normalized))];
}

/**
 * The smallest child window carrying every matn token the child holds, measured
 * against the matn's own distinct-token count. A verbatim matn sits in a window
 * about its own length; tokens scattered through the narration need a wide one.
 */
export function containmentEvidence(
  queryTokens: readonly string[],
  candidate: EvidenceChild,
): ContainmentEvidence {
  const present = queryTokens.filter((token) => candidate.tokenSet.has(token));
  if (present.length === 0) return { tokenCoverage: 0, windowRatio: Number.POSITIVE_INFINITY };

  // Two pointers over the positions of the tokens the child holds: the smallest
  // window containing one occurrence of every present matn token.
  const needed = new Map(present.map((token) => [token, 0]));
  const positions: number[] = [];
  for (let index = 0; index < candidate.tokenSequence.length; index += 1) {
    if (needed.has(candidate.tokenSequence[index] as string)) positions.push(index);
  }
  let left = 0;
  let covered = 0;
  let span = Number.POSITIVE_INFINITY;
  for (let right = 0; right < positions.length; right += 1) {
    const token = candidate.tokenSequence[positions[right] as number] as string;
    const count = (needed.get(token) ?? 0) + 1;
    needed.set(token, count);
    if (count === 1) covered += 1;
    while (covered === present.length) {
      const width = (positions[right] as number) - (positions[left] as number) + 1;
      if (width < span) span = width;
      const leftToken = candidate.tokenSequence[positions[left] as number] as string;
      const remaining = (needed.get(leftToken) ?? 0) - 1;
      needed.set(leftToken, remaining);
      if (remaining === 0) covered -= 1;
      left += 1;
    }
  }
  return {
    tokenCoverage: present.length / queryTokens.length,
    windowRatio: span / queryTokens.length,
  };
}

/**
 * Why a containment target is only a fragment, or `null` when the relation holds.
 * The tests run from the cheapest and most fundamental (is this a text at all?)
 * to the relation itself (is it carried by a comparable narration?).
 */
export function containmentRefusal(
  queryNormalized: string,
  queryTokens: readonly string[],
  evidence: ContainmentEvidence,
  candidate: EvidenceChild,
): string | null {
  if (queryTokens.length < MIN_CONTAINMENT_TOKENS) {
    return (
      `the matn has ${queryTokens.length} distinct token${queryTokens.length === 1 ? "" : "s"}; ` +
      `the containment floor is ${MIN_CONTAINMENT_TOKENS}`
    );
  }
  if (queryNormalized.length < MIN_CONTAINMENT_CHARS) {
    return (
      `the matn has ${queryNormalized.length} normalized characters; ` +
      `the containment floor is ${MIN_CONTAINMENT_CHARS}`
    );
  }
  if (evidence.tokenCoverage < MIN_TOKEN_COVERAGE) {
    return (
      `only ${(evidence.tokenCoverage * 100).toFixed(0)}% of the matn's tokens occur in the ` +
      `candidate; the floor is ${(MIN_TOKEN_COVERAGE * 100).toFixed(0)}%`
    );
  }
  if (evidence.windowRatio > MAX_MATCH_WINDOW_RATIO) {
    return (
      `the matched tokens span ${evidence.windowRatio.toFixed(1)}x the matn's ` +
      `${queryTokens.length} tokens; the ceiling is ${MAX_MATCH_WINDOW_RATIO}x`
    );
  }
  const narrationRatio = candidate.normalized.length / Math.max(queryNormalized.length, 1);
  if (narrationRatio > MAX_NARRATION_MATN_CHAR_RATIO) {
    return (
      `the stored narration is ${narrationRatio.toFixed(1)}x the matn's characters; ` +
      `the ceiling is ${MAX_NARRATION_MATN_CHAR_RATIO}x`
    );
  }
  return null;
}
