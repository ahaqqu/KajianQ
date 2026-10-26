import type { RoutedQuery } from "@app/rag-core";
import type { KajianQFilters } from "../filters";

/**
 * A routed query for tests. The Router stage returns only its *reading* of the
 * question and the engine's runner stamps the caller's verbatim text and prior
 * turns onto it (ADR-0018), so a test that hands a stage its input directly
 * builds that same shape here instead of re-deriving it in every file.
 *
 * The default sub-query carries the caller's verbatim question the way the
 * decomposition repair labels that entry in production — `role: "factual"`,
 * `origin: "rule"` — so a stage that selects the caller's sub-query (the
 * retriever's caller-priority guarantee) sees a production-shaped route rather
 * than a label production never writes. A suite that needs a route the
 * guarantee does not cover — the router's paraphrase-only fan-out, or the
 * fallback route's `origin: "fallback"` — passes its own `subQueries`.
 */
export function routedQuery(
  /** The verbatim question — the stamped `sourceText` and the caller's sub-query. */
  sourceText = "Apa itu Ayat Kursi?",
  overrides: Partial<RoutedQuery<KajianQFilters>> = {},
): RoutedQuery<KajianQFilters> {
  return {
    intent: "factual",
    subQueries: [{ text: sourceText, role: "factual", origin: "rule" }],
    filters: {},
    ...overrides,
    sourceText,
  };
}
