import { Effect } from "effect";
import type { DocChildById, RagStore, RetrievalTrack, SimilarChild } from "./rag-store";
import {
  checkEmbedding,
  CORPUS_EMBEDDING_DIM,
  rowToChildEffect,
  toVectorLiteral,
  type ChildRow,
} from "./rag-store-shared";
import { buildSimilarityQuery } from "./rag-store-neon-query";
import { sqlEffect, type SqlRunner } from "./rag-store-neon-errors";

/**
 * The Neon adapter's corpus reads — the similarity search and the by-id
 * child lookup — split from the corpus module to respect the agentic size
 * limits. Part of the Neon adapter SQL surface
 * (ADR-0027 decision 7). The embedding is validated BEFORE the query runs:
 * a misconfigured provider or ingestion bug fails loudly at the seam as a
 * `constraint` StoreError, never as an opaque pgvector dimension error, and
 * corrupt stored vectors/timestamps fail constraint-class on the way out —
 * never silently coerced into NaNs that would propagate into retrieval.
 *
 * The failure type is `StoreError` by construction (`sqlEffect` and the
 * shared helpers never fail with anything else), so the return type is
 * left inferred rather than re-annotated — the seam interface
 * (`RagStore.similaritySearch`) checks assignability at the composition
 * root.
 */
export function neonSimilaritySearch(
  sql: SqlRunner,
  track: RetrievalTrack,
  embedding: readonly number[],
  opts: NonNullable<Parameters<RagStore["similaritySearch"]>[2]>,
) {
  return Effect.flatMap(checkEmbedding(embedding, CORPUS_EMBEDDING_DIM), () => {
    const literal = toVectorLiteral(embedding);
    const filters = Object.entries(opts.filters ?? {});
    // $1 embedding, $2 limit, then per filter: the key string ($k) and the
    // values array ($v) — both bound, matching buildSimilarityQuery's slots.
    const params: unknown[] = [literal, opts.limit];
    for (const [key, val] of filters) {
      params.push(key, Array.isArray(val) ? val : [val]);
    }
    const query = buildSimilarityQuery(track, filters.length);
    return Effect.flatMap(
      sqlEffect(
        sql,
        () =>
          sql.query(query, params) as Promise<
            (ChildRow & { distance: unknown; rank_dense: unknown })[]
          >,
      ),
      (rows) =>
        Effect.map(
          Effect.forEach(rows, (r) =>
            Effect.map(rowToChildEffect(r), (child) => ({
              child,
              distance: Number(r.distance),
              rankDense: Number(r.rank_dense),
            })),
          ),
          (hits) => hits satisfies SimilarChild[],
        ),
    );
  });
}

/**
 * The by-id child read behind the structured citation payload (#11). Same
 * embedding-stripping contract as the similarity search above: the caller
 * reads text/citation/metadata, so the vector columns are selected as NULL
 * and stay null on the mapped rows. The parent join carries the display
 * title the citation payload shows as the passage's source reference.
 */
export function neonChildMethods(sql: SqlRunner): Pick<RagStore, "getDocChildrenByIds"> {
  return {
    getDocChildrenByIds(ids) {
      const unique = [...new Set(ids)].filter((id) => id.trim() !== "");
      if (unique.length === 0) return Effect.succeed([] as readonly DocChildById[]);
      return Effect.flatMap(
        sqlEffect(
          sql,
          () =>
            sql.query(
              `
          SELECT c.id, c.parent_id, c.text_raw, c.text_ar, c.text_id, c.citation,
                 NULL::text AS embedding_primary, NULL::text AS embedding_fallback,
                 c.ordinal, c.metadata, c.created_at, p.title AS parent_title
          FROM doc_children c
          LEFT JOIN doc_parents p ON p.id = c.parent_id
          WHERE c.id = ANY($1::uuid[])
        `,
              [unique],
            ) as Promise<(ChildRow & { parent_title: string | null })[]>,
        ),
        (rows) =>
          Effect.forEach(rows, (r) =>
            Effect.map(rowToChildEffect(r), (child): DocChildById => ({
              ...child,
              parentTitle: r.parent_title ?? null,
            })),
          ),
      );
    },
  };
}
