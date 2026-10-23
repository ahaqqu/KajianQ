/**
 * The opt-in any-of set's scope contract, enforced at the scorer boundary.
 *
 * `citationAlternatives` answers a single-requirement row: the curator ruled that
 * any member of the set is a valid answer to that one question. The Golden Set
 * contract rejects a set on a multi-requirement row, but the scorers are package
 * exports and `scoreQuestion` takes a hand-built `GoldenQuestion`, so a set that
 * reached them on a multi-requirement row would widen every requirement it was
 * applied to — an AND row scoring as if it were any-of. The engine therefore
 * refuses the mis-shaped row loudly instead of applying the set wherever it lands.
 */

/** Thrown when an alternative set arrives on a row it cannot describe. */
export class CitationAlternativesScopeError extends Error {
  readonly kind = "citation_alternatives_scope";

  constructor(message: string) {
    super(message);
    this.name = "CitationAlternativesScopeError";
  }
}

/**
 * Throw unless the alternative set belongs to the row's one requirement. Called at
 * the top of every scorer that applies the set, so no path can widen a sibling.
 */
export function requireAlternativesScope(
  requiredCitations: readonly string[],
  alternatives: readonly string[],
): void {
  if (alternatives.length > 0 && requiredCitations.length !== 1) {
    throw new CitationAlternativesScopeError(
      `citationAlternatives applies to a row with exactly one required citation, not ${requiredCitations.length}`,
    );
  }
}
