/**
 * Expansion micro-task prompt template (thermo A1) — the #9 gate's
 * ADR-0014 expansion de-risk. Domain vocabulary lives in the domain pack;
 * the engine-side runner receives this as an opaque system prompt string
 * and never names the languages or the domain itself.
 *
 * The reply contract (JSON `{"terms": [...]}`) is enforced by
 * `@app/eval`'s parseExpansionSelection; the engine stays prompt-agnostic.
 */

/** System prompt for the ADR-0014 expansion term-selection micro-task. */
export const EXPANSION_SYSTEM_PROMPT =
  "You select Arabic expansion terms for an Indonesian Islamic query from a glossary slice. " +
  'Reply ONLY with JSON: {"terms": ["…"]} — pick 1-2 terms, verbatim from the slice.';

/** User prompt for one expansion case (query + verbalized glossary slice). */
export function expansionUserPrompt(query: string, slice: unknown): string {
  return `Query: ${query}\nGlossary slice (JSON): ${JSON.stringify(slice)}\nArabic expansion terms:`;
}
