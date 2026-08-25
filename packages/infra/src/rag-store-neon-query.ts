import type { RetrievalTrack } from "./rag-store";

/**
 * Neon-specific similarity-search SQL builder.
 *
 * This is pure (no I/O) but Neon/Postgres-specific, so it lives beside the
 * adapter rather than in the DB-free `rag-store-shared.ts`. Keeping it in its
 * own module means the executable SQL stays in the Neon adapter surface
 * (satisfying "all SQL in the adapter package") while remaining unit-testable
 * and coverage-gated without a live database.
 *
 * Invariant: no column identifier is ever built from input. The only runtime
 * choice is which of two fixed columns (a hard allowlist) the query targets;
 * filter keys and values are bound parameters ($N).
 */

/**
 * Track role → physical embedding column. The two-column allowlist is the
 * whole point of ADR-0013's dual-track schema; `primary`/`fallback` are
 * engine-level role names — KajianQ binds them to its AR/ID language tracks
 * at the domain-pack boundary, so no language code appears here.
 */
const SIMILARITY_COLUMNS: Record<RetrievalTrack, string> = {
  primary: "embedding_primary",
  fallback: "embedding_fallback",
};

/**
 * Build the similarity-search SQL string for a track with `filterCount`
 * metadata filters. Parameter slots: $1 = embedding, $2 = limit, then for each
 * filter a key slot and an array slot, assigned from a running counter (so
 * the arithmetic stays local and auditable rather than magic offsets).
 */
export function buildSimilarityQuery(
  track: RetrievalTrack,
  filterCount: number,
): string {
  const column = SIMILARITY_COLUMNS[track];
  const select = `
  SELECT id, parent_id, text_raw, text_ar, text_id, citation,
         embedding_primary::text AS embedding_primary,
         embedding_fallback::text AS embedding_fallback,
         ordinal, metadata, created_at,
         (${column} <=> $1::vector) AS distance,
         ROW_NUMBER() OVER (ORDER BY ${column} <=> $1::vector) AS rank_dense
  FROM doc_children
  WHERE ${column} IS NOT NULL`;
  if (filterCount <= 0) {
    return `${select}\n  ORDER BY ${column} <=> $1::vector\n  LIMIT $2\n`;
  }
  // $1 embedding, $2 limit → filters start at $3, two slots each (key, array).
  let slot = 3;
  const clauses: string[] = [];
  for (let i = 0; i < filterCount; i += 1) {
    const kIdx = slot++;
    const vIdx = slot++;
    clauses.push(`metadata->>$${kIdx} = ANY($${vIdx}::text[])`);
  }
  return `${select}\n        AND ${clauses.join("\n        AND ")}\n  ORDER BY ${column} <=> $1::vector\n  LIMIT $2\n`;
}