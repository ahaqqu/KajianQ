import { Effect } from "effect";
import type { AlignedPairInsert, DocChildInsert, RagStore } from "./rag-store";
import { buildBatchChildUpsert } from "./rag-store-postgres-batch";
import { sqlEffect, type SqlRunner } from "./rag-store-postgres-errors";
import { postgresChildMethods, postgresSimilaritySearch } from "./rag-store-postgres-similarity";

/**
 * Corpus methods of the Postgres RagStore adapter, split from
 * `rag-store-postgres.ts` to respect the agentic size limits. Part of the Postgres
 * adapter SQL surface (ADR-0027 decision 7): parents upsert by source_key,
 * children by (parent_id, ordinal) — text_raw is immutable; pairs by pair_key.
 * The similarity search lives in
 * `rag-store-postgres-similarity.ts`: it validates the embedding BEFORE the
 * query so a bad vector fails as a `constraint` StoreError at the seam, not
 * an opaque pgvector error.
 */
export function postgresCorpusMethods(
  sql: SqlRunner,
): Pick<
  RagStore,
  | "insertDocParent"
  | "insertDocChild"
  | "insertDocChildren"
  | "upsertAlignedPair"
  | "similaritySearch"
  | "getDocChildrenByIds"
  | "countDocChildrenByMetadata"
  | "listDocChildrenByParentSourceKey"
  | "findDocChildrenByMetadata"
  | "listDocChildNeighboursByChildIds"
  | "deleteCorpusRows"
> {
  return {
    insertDocParent(input) {
      const id = input.id ?? crypto.randomUUID();
      // Idempotent upsert by provenance key: re-running
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
      // Idempotent upsert by provenance key: re-running
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
      return postgresSimilaritySearch(sql, track, embedding, opts);
    },

    /**
     * Both deletes in one transaction, chain sweep first: an explicit addressed
     * chain set is removed and counted, then the child sweep's cascade catches
     * whatever a stale child still held. Unknown ids and addresses delete nothing.
     */
    deleteCorpusRows(input) {
      if (input.childIds.length === 0 && input.chains.length === 0) {
        return Effect.succeed({ childrenDeleted: 0, chainsDeleted: 0 });
      }
      return sqlEffect(sql, async () => {
        const statements: unknown[] = [];
        const counted: ("chains" | "children")[] = [];
        if (input.chains.length > 0) {
          statements.push(sql`
            DELETE FROM narrator_chains c
            USING unnest(${input.chains.map((row) => row.collection)}::text[],
                        ${input.chains.map((row) => row.sourceRef)}::text[])
                  AS d(collection, source_ref)
            WHERE c.collection = d.collection AND c.source_ref = d.source_ref
            RETURNING c.id
          `);
          counted.push("chains");
        }
        if (input.childIds.length > 0) {
          statements.push(
            sql`DELETE FROM doc_children WHERE id = ANY(${input.childIds}::uuid[]) RETURNING id`,
          );
          counted.push("children");
        }
        const results = (await sql.transaction(statements)) as { id: string }[][];
        let chainsDeleted = 0;
        let childrenDeleted = 0;
        results.forEach((rows, index) => {
          if (counted[index] === "chains") chainsDeleted = rows.length;
          else childrenDeleted = rows.length;
        });
        return { childrenDeleted, chainsDeleted };
      });
    },

    // The by-id read behind the structured citation payload; the
    // implementation shares the similarity module's row machinery.
    ...postgresChildMethods(sql),
  };
}
