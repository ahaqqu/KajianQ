import { StoreError } from "@app/rag-core";
import { Effect } from "effect";
import {
  chainWriteProblem,
  narratorWriteProblem,
  type NarratorChainInsert,
  type NarratorUpsert,
} from "./rag-store-narrator-write-seam";
import { rowToNarrator, type NarratorRow } from "./rag-store-postgres-narrator";
import { sqlEffect, type SqlRunner } from "./rag-store-postgres-errors";

/**
 * The write half of the Postgres narrator adapter, split from the read module so
 * each concern stays one file. It is the only place the two write upserts are
 * expressed as SQL; the natural keys they target are 0004's unique indexes, and
 * the pre-flight predicates it calls are the ones the in-memory double calls too.
 *
 * Both statements are idempotent by construction:
 *
 * - the narrator insert conflicts on `identity_key` (never on a name), keeps the
 *   canonical spelling fixed at first write, appends any spelling it has not
 *   recorded as a variant, and fills a still-unknown pass-through column rather
 *   than blanking one it already holds;
 * - the chain insert conflicts on `(collection, source_ref)` and updates the
 *   child, the ordered narrator sequence and the grade pair in place, so a
 *   second run rewrites its own rows instead of appending a parallel chain.
 *
 * The chain batch is written in chunks. A failure between chunks leaves the
 * earlier chunks written; that is safe, not silent, because every chunk is an
 * upsert a rerun reproduces exactly — the write path's contract is that a rerun
 * converges, not that a batch is one transaction.
 */

/** Rows per multi-row chain statement: bounded so one statement stays well under the parameter cap. */
export const CHAIN_INSERT_CHUNK = 500;

function reject(problem: string): Effect.Effect<never, StoreError> {
  return Effect.fail(new StoreError({ kind: "constraint", cause: new Error(problem) }));
}

/** One chunk's SQL and the parameter values for its rows. */
function chainChunk(rows: readonly NarratorChainInsert[]): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const tuples = rows.map((row, index) => {
    const base = index * 6;
    values.push(
      row.childId,
      row.collection,
      row.narratorIds,
      row.grade ?? null,
      row.grader ?? null,
      row.sourceRef,
    );
    return `($${base + 1}::uuid, $${base + 2}::text, $${base + 3}::uuid[], $${base + 4}::text, $${base + 5}::text, $${base + 6}::text)`;
  });
  return {
    text: `
    INSERT INTO narrator_chains (child_id, collection, narrator_ids, grade, grader, source_ref)
    VALUES ${tuples.join(",\n")}
    ON CONFLICT (collection, source_ref) WHERE source_ref IS NOT NULL DO UPDATE
      SET child_id = EXCLUDED.child_id,
          narrator_ids = EXCLUDED.narrator_ids,
          grade = EXCLUDED.grade,
          grader = EXCLUDED.grader,
          updated_at = now()
    RETURNING id
  `,
    values,
  };
}

export function postgresNarratorWriteMethods(sql: SqlRunner) {
  return {
    upsertNarrator(input: NarratorUpsert) {
      const problem = narratorWriteProblem(input);
      if (problem !== null) return reject(problem);
      const write = () =>
        sql`
          INSERT INTO narrators (
            identity_key, canonical_name_ar, name_variants, kunya, laqab, death_year,
            tabaqa, reliability_by_critic, metadata
          )
          VALUES (
            ${input.identityKey},
            ${input.canonicalNameAr},
            ${[...(input.nameVariants ?? [])]}::text[],
            ${input.kunya ?? null},
            ${input.laqab ?? null},
            ${input.deathYear ?? null},
            ${input.tabaqa ?? null},
            ${JSON.stringify(input.reliabilityByCritic ?? {})}::jsonb,
            ${JSON.stringify(input.metadata ?? {})}::jsonb
          )
          ON CONFLICT (identity_key) DO UPDATE
            SET name_variants = narrators.name_variants || ARRAY(
                  SELECT spelling
                  FROM unnest(EXCLUDED.name_variants) AS spelling
                  WHERE spelling <> ALL (narrators.name_variants)
                ),
                kunya = COALESCE(narrators.kunya, EXCLUDED.kunya),
                laqab = COALESCE(narrators.laqab, EXCLUDED.laqab),
                death_year = COALESCE(narrators.death_year, EXCLUDED.death_year),
                tabaqa = COALESCE(narrators.tabaqa, EXCLUDED.tabaqa),
                reliability_by_critic = narrators.reliability_by_critic || EXCLUDED.reliability_by_critic,
                metadata = narrators.metadata || EXCLUDED.metadata,
                updated_at = now()
          RETURNING id, canonical_name_ar, name_variants, kunya, laqab, death_year,
                    tabaqa, reliability_by_critic, metadata
        ` as Promise<NarratorRow[]>;
      return Effect.flatMap(sqlEffect(sql, write), (rows) => {
        const row = rows[0];
        return row === undefined
          ? reject(`narrator '${input.identityKey}' write returned no row`)
          : Effect.succeed(rowToNarrator(row));
      });
    },

    insertNarratorChains(rows: readonly NarratorChainInsert[]) {
      if (rows.length === 0) return Effect.succeed([] as readonly string[]);
      for (const row of rows) {
        const problem = chainWriteProblem(row);
        if (problem !== null) return reject(problem);
      }
      const chunks: NarratorChainInsert[][] = [];
      for (let start = 0; start < rows.length; start += CHAIN_INSERT_CHUNK) {
        chunks.push(rows.slice(start, start + CHAIN_INSERT_CHUNK));
      }
      // Sequential on purpose: the read's `seq` order is the order the rows reach
      // the table, and one connection preserves it; concurrent chunks would not.
      return Effect.gen(function* () {
        const ids: string[] = [];
        for (const chunk of chunks) {
          const { text, values } = chainChunk(chunk);
          const written = yield* sqlEffect(
            sql,
            () => sql.query(text, values) as Promise<{ id: string }[]>,
          );
          ids.push(...written.map((row) => row.id));
        }
        return ids as readonly string[];
      });
    },
  };
}
