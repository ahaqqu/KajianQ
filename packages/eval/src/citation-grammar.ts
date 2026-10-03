import type { CitationGrammar } from "./harness-types";

/**
 * The engine's grammar contract, enforced at its own entry (review R1 of the
 * #274 fix round).
 *
 * `CitationGrammar.addressesNamedBy` is what lets the scorer compare a required
 * citation and the answer's evidence as the **sets of addresses they name**
 * rather than as strings — without it a question requiring `QS. 2:255` and an
 * answer citing the grounded range `QS. 2:255-256` scores 0 on the frame path
 * while the same evidence through the trace's `grounded` list scores 1 (review
 * A1 of the fix round; measured at head 171b858 with the real domain grammar
 * and the real `deriveCitationsFrame` output `["QS. 2:255-256"]`: declaration
 * present 1/1/1 on the frame/events/text paths, declaration absent 0/1/0).
 *
 * A type alone cannot hold that line, because the production injector is
 * JavaScript: `packages/eval/scripts/staging-harness.mjs` builds the grammar as
 * an object literal, so deleting one property there compiles, passes every
 * test, and silently restores the exact defect A1 closed. The engine therefore
 * refuses to score with a grammar that cannot answer what a label names —
 * loudly, at the grammar-consuming entry, instead of falling back to a
 * comparison the injected grammar never agreed to.
 *
 * The fallback is deleted, not weakened: a grammar with no list-valued
 * citation form declares that honestly as `(label) => [label]` (see
 * {@link CitationGrammar.addressesNamedBy}), so the injector is always obliged
 * to say what a label names.
 */

/** Thrown when an injected grammar arrives without its naming declaration. */
export class CitationGrammarError extends Error {
  readonly kind = "citation_grammar_missing_naming";
  constructor(msg: string) {
    super(msg);
    this.name = "CitationGrammarError";
  }
}

/**
 * Pass a grammar through if the scorer can ask it what a label names, or throw
 * a {@link CitationGrammarError} naming the missing member. Called at the top
 * of the engine's grammar-consuming entries, so no scoring path can reach a
 * silent string-only comparison.
 */
export function requireCitationGrammar(grammar: CitationGrammar): CitationGrammar {
  if (typeof grammar.addressesNamedBy !== "function") {
    throw new CitationGrammarError(
      "injected citation grammar has no `addressesNamedBy`: the scorer cannot tell " +
        "which addresses a label names, so a grounded range would silently score 0. " +
        "A grammar with no list-valued citation form must declare `(label) => [label]`.",
    );
  }
  return grammar;
}
