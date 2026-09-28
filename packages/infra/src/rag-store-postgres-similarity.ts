import { Effect } from "effect";
import type { DocChildById, RagStore, RetrievalTrack, SimilarChild } from "./rag-store";
import {
  checkEmbedding,
  CORPUS_EMBEDDING_DIM,
  rowToChildEffect,
  toVectorLiteral,
  type ChildRow,
} from "./rag-store-shared";
import { buildSimilarityQuery } from "./rag-store-postgres-query";
import { sqlEffect, type SqlRunner } from "./rag-store-postgres-errors";

/**
 * The Postgres adapter's corpus reads — the similarity search and the by-id
 * child lookup — split from the corpus module to respect the agentic size
 * limits. Part of the Postgres adapter SQL surface
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
export function postgresSimilaritySearch(
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
export function postgresChildMethods(
  sql: SqlRunner,
): Pick<
  RagStore,
  | "getDocChildrenByIds"
  | "countDocChildrenByMetadata"
  | "listDocChildrenByParentSourceKey"
  | "listDocChildNeighboursByChildIds"
> {
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

    listDocChildrenByParentSourceKey(parentSourceKey, opts) {
      // The parent's source_key is UNIQUE and indexed, so the join is a point
      // lookup; `ordinal` is the corpus's stable within-parent order (the
      // `UNIQUE (parent_id, ordinal)` key), which is what makes the bounded
      // window deterministic. A non-positive limit can never be a real read
      // (the seam requires the caller to bound it), so it short-circuits
      // instead of issuing `LIMIT 0`.
      if (opts.limit <= 0) return Effect.succeed([] as readonly DocChildById[]);
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
          JOIN doc_parents p ON p.id = c.parent_id
          WHERE p.source_key = $1
          ORDER BY c.ordinal ASC, c.id ASC
          LIMIT $2
        `,
              [parentSourceKey, opts.limit],
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

    listDocChildNeighboursByChildIds(anchorChildIds, opts) {
      // The anchors are the ids the caller already retrieved; their parent and
      // ordinal come from the stored rows (`unnest … WITH ORDINALITY` keeps the
      // caller's priority order), so the window is anchored on what was
      // retrieved rather than on a second derivation of a chunk's position
      // (ADR-0049). The inner `DISTINCT ON (id)` gives a neighbour reachable
      // from several anchors to the earliest one, and `ORDER BY anchor, ordinal`
      // makes the cap drop the least important windows — both bound parameters,
      // as is the limit. A non-positive radius or limit is not a read at all.
      const unique = [...new Set(anchorChildIds)].filter((id) => id.trim() !== "");
      if (opts.radius <= 0 || opts.limit <= 0 || unique.length === 0) {
        return Effect.succeed([] as readonly DocChildById[]);
      }
      return Effect.flatMap(
        sqlEffect(
          sql,
          () =>
            sql.query(
              `
          WITH anchors AS (
            SELECT a.id AS anchor_id, a.ord AS anchor_pos, c.parent_id, c.ordinal
            FROM unnest($1::uuid[]) WITH ORDINALITY AS a(id, ord)
            JOIN doc_children c ON c.id = a.id
          )
          SELECT n.id, n.parent_id, n.text_raw, n.text_ar, n.text_id, n.citation,
                 NULL::text AS embedding_primary, NULL::text AS embedding_fallback,
                 n.ordinal, n.metadata, n.created_at, p.title AS parent_title
          FROM (
            SELECT DISTINCT ON (n.id) n.id, n.ordinal, n.parent_id, an.anchor_pos
            FROM anchors an
            JOIN doc_children n
              ON n.parent_id = an.parent_id
             AND n.ordinal BETWEEN an.ordinal - $2 AND an.ordinal + $2
             AND n.id <> an.id
            ORDER BY n.id, an.anchor_pos, n.ordinal
          ) w
          JOIN doc_children n ON n.id = w.id
          LEFT JOIN doc_parents p ON p.id = n.parent_id
          ORDER BY w.anchor_pos, w.ordinal, w.id
          LIMIT $3
        `,
              [unique, opts.radius, opts.limit],
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

    countDocChildrenByMetadata(key) {
      // The metadata key is a bound parameter ($1), never interpolated — the
      // same invariant the similarity query builder holds. Rows without a
      // string value for the key group under SQL NULL.
      return sqlEffect(
        sql,
        () =>
          sql.query(
            `
          SELECT metadata->$1 AS value, count(*)::int AS count
          FROM doc_children
          WHERE metadata ? $1 AND jsonb_typeof(metadata->$1) = 'string'
          GROUP BY metadata->$1
          ORDER BY count DESC
        `,
            [key],
          ) as Promise<{ value: string | null; count: number }[]>,
      );
    },
  };
}
