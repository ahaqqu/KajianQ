import { Effect } from "effect";
import type { AlignedPairInsert, DocChildInsert, RagStore } from "./rag-store";
import { buildBatchChildUpsert } from "./rag-store-neon-batch";
import { sqlEffect, type SqlRunner } from "./rag-store-neon-errors";
import { neonSimilaritySearch } from "./rag-store-neon-similarity";

/**
 * Corpus methods of the Neon RagStore adapter, split from
 * `rag-store-neon.ts` to respect the agentic size limits. Part of the Neon
 * adapter SQL surface (ADR-0027 decision 7): parents upsert by source_key
 * (AGENTS.md rule 13), children by (parent_id, ordinal) — text_raw is
 * immutable; pairs by pair_key (rule 11). The similarity search lives in
 * `rag-store-neon-similarity.ts`: it validates the embedding BEFORE the
 * query so a bad vector fails as a `constraint` StoreError at the seam, not
 * an opaque pgvector error.
 */
export function neonCorpusMethods(
  sql: SqlRunner,
): Pick<
  RagStore,
  | "insertDocParent"
  | "insertDocChild"
  | "insertDocChildren"
  | "upsertAlignedPair"
  | "similaritySearch"
> {
  return {
    insertDocParent(input) {
      const id = input.id ?? crypto.randomUUID();
      // Idempotent upsert by provenance key (AGENTS.md rule 13): re-running
      // ingestion with the same source_key updates metadata/title in place
      // and returns the existing id, never duplicates.
      const run = () =>
        sql`
          INSERT INTO doc_parents (id, source_key, title, metadata)
          VALUES (
            ${id}, ${input.sourceKey}, ${input.title},
            ${JSON.stringify(input.metadata ?? {})}::jsonb
          )
          ON CONFLICT (source_key) DO UPDATE
            SET title = EXCLUDED.title, metadata = EXCLUDED.metadata
          RETURNING id
        ` as Promise<{ id: string }[]>;
      return Effect.map(sqlEffect(sql, run), (rows) => rows[0]?.id ?? id);
    },

    insertDocChild(input: DocChildInsert) {
      return Effect.map(this.insertDocChildren([input]), (ids) => ids[0] ?? crypto.randomUUID());
    },

    insertDocChildren(batch: readonly DocChildInsert[]) {
      if (batch.length === 0) return Effect.succeed([] as readonly string[]);
      return Effect.flatMap(buildBatchChildUpsert(batch), ({ text, values, rowIds }) =>
        Effect.map(
          sqlEffect(sql, () => sql.query(text, values) as Promise<{ id: string }[]>),
          (rows) =>
            // The single-row path falls back to the generated id when RETURNING is
            // empty, preserving insertDocChild's upsert semantics.
            rows.map((r, i) => r.id ?? rowIds[i] ?? crypto.randomUUID()),
        ),
      );
    },

    upsertAlignedPair(input: AlignedPairInsert) {
      const id = crypto.randomUUID();
      // Idempotent upsert by provenance key (AGENTS.md rule 11): re-running
      // ingestion with the same pair_key refreshes the tracks, citation, and
      // morphology in place and returns the existing id, never duplicates.
      // Column names are role-based (`text_primary`/`text_secondary`); the
      // domain pack binds the roles to its language tracks at its boundary.
      return Effect.map(
        sqlEffect(
          sql,
          () =>
            sql`
          INSERT INTO aligned_pairs (id, pair_key, citation, text_primary, text_secondary, morphology)
          VALUES (
            ${id}, ${input.pairKey},
            ${JSON.stringify(input.citation)}::jsonb,
            ${input.textPrimary},
            ${input.textSecondary},
            ${JSON.stringify(input.morphology ?? [])}::jsonb
          )
          ON CONFLICT (pair_key) DO UPDATE
            SET citation = EXCLUDED.citation,
                text_primary = EXCLUDED.text_primary,
                text_secondary = EXCLUDED.text_secondary,
                morphology = EXCLUDED.morphology,
                updated_at = now()
          RETURNING id
        ` as Promise<{ id: string }[]>,
        ),
        (rows) => rows[0]?.id ?? id,
      );
    },

    similaritySearch(track, embedding, opts) {
      return neonSimilaritySearch(sql, track, embedding, opts);
    },
  };
}
