import type { RoutedQuery } from "@app/rag-core";
import type { KajianQFilters } from "../filters";

/**
 * A routed query for tests. The Router stage returns only its *reading* of the
 * question and the engine's runner stamps the caller's verbatim text and prior
 * turns onto it (ADR-0018), so a test that hands a stage its input directly
 * builds that same shape here instead of re-deriving it in every file.
 */
export function routedQuery(
  /** The verbatim question — the stamped `sourceText` and the factual sub-query. */
  sourceText = "Apa itu Ayat Kursi?",
  overrides: Partial<RoutedQuery<KajianQFilters>> = {},
): RoutedQuery<KajianQFilters> {
  return {
    intent: "factual",
    subQueries: [{ text: sourceText, role: "factual", origin: "model" }],
    filters: {},
    ...overrides,
    sourceText,
  };
}
