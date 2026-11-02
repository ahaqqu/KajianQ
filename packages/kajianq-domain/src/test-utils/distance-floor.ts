import { Effect } from "effect";
import type { RagStore } from "@app/infra";

/**
 * The memory stand-in's `similaritySearch` returns every row in reach, nearest
 * first, so every seeded row lands in every search's window. A real search over
 * the corpus returns a bounded top-k, and the passage a query must *not* reach is
 * simply not among the nearest rows. A test that needs that distinction declares
 * it here: keep only hits within a cosine distance (lower is closer).
 *
 * Test-only — the adapter's contract is unchanged, and a test using this says by
 * calling it that the retrieval it asserts is the declared window, not the
 * stand-in's whole table.
 */
export function withDistanceFloor<T extends { similaritySearch: RagStore["similaritySearch"] }>(
  store: T,
  maxDistance: number,
): T {
  const similaritySearch: RagStore["similaritySearch"] = (track, embedding, opts) =>
    Effect.map(store.similaritySearch(track, embedding, opts), (hits) =>
      hits.filter((hit) => hit.distance <= maxDistance),
    );
  return { ...store, similaritySearch };
}
