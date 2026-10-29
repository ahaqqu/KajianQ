import { Effect } from "effect";
import type { RagStore } from "./rag-store";
import type {
  NarratorChainRecord,
  NarratorIdsLookup,
  NarratorRecord,
} from "./rag-store-narrator-seam";
import { sqlEffect, type SqlRunner } from "./rag-store-postgres-errors";

/**
 * Narrator/graph methods of the Postgres `RagStore` adapter, split from
 * `rag-store-postgres.ts` to respect the agentic size limits. The tables are
 * domain-owned (they live in the domain pack's migrations); the seam names them
 * by role and never interprets a row: values pass through verbatim, and the
 * ordering rules below are the contract the in-memory double mirrors.
 *
 * Every read validates nothing about domain vocabulary — a grade is a string, a
 * critic map is opaque JSONB — so a second product can store a different
 * vocabulary behind the same seam.
 */

/** A narrator row with the driver's snake_case column names. */
type NarratorRow = {
  id: string;
  canonical_name_ar: string;
  name_variants: string[] | null;
  kunya: string | null;
  laqab: string | null;
  death_year: number | null;
  tabaqa: string | null;
  reliability_by_critic: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};

/** A chain row with the driver's snake_case column names. */
type ChainRow = {
  id: string;
  child_id: string;
  collection: string;
  narrator_ids: string[] | null;
  grade: string | null;
  grader: string | null;
  source_ref: string | null;
};

function rowToNarrator(row: NarratorRow): NarratorRecord {
  return {
    id: row.id,
    canonicalNameAr: row.canonical_name_ar,
    nameVariants: row.name_variants ?? [],
    kunya: row.kunya,
    laqab: row.laqab,
    deathYear: row.death_year,
    tabaqa: row.tabaqa,
    reliabilityByCritic: row.reliability_by_critic ?? {},
    metadata: row.metadata ?? {},
  };
}

function rowToChain(row: ChainRow): NarratorChainRecord {
  return {
    id: row.id,
    childId: row.child_id,
    collection: row.collection,
    narratorIds: row.narrator_ids ?? [],
    grade: row.grade,
    grader: row.grader,
    sourceRef: row.source_ref,
  };
}

export function postgresNarratorMethods(
  sql: SqlRunner,
): Pick<
  RagStore,
  "findNarratorsByName" | "getNarratorsByIds" | "listChainsForChild" | "listChainsByCollection"
> {
  return {
    findNarratorsByName(name, opts) {
      // An unbounded or empty lookup is not a read: the seam requires a positive
      // limit, and no stored narrator has an empty canonical name.
      if (opts.limit <= 0 || name.trim() === "") return Effect.succeed([] as NarratorRecord[]);
      // Exact, unnormalised matching on purpose: Arabic folding is domain logic,
      // so the store matches the strings it is given. `@>` is the array
      // containment form the variants GIN index serves; `ORDER BY id` is the one
      // order both implementations can guarantee without a collation assumption.
      return Effect.map(
        sqlEffect(
          sql,
          () =>
            sql`
              SELECT id, canonical_name_ar, name_variants, kunya, laqab, death_year,
                     tabaqa, reliability_by_critic, metadata
              FROM narrators
              WHERE canonical_name_ar = ${name} OR name_variants @> ARRAY[${name}]::text[]
              ORDER BY id
              LIMIT ${opts.limit}
            ` as Promise<NarratorRow[]>,
        ),
        (rows) => rows.map(rowToNarrator),
      );
    },

    getNarratorsByIds(ids) {
      const unique = [...new Set(ids)].filter((id) => id.trim() !== "");
      if (unique.length === 0) {
        return Effect.succeed({ narrators: [] as NarratorRecord[], missingIds: [] as string[] });
      }
      // The rows come back in whatever order the plan yields; the caller's order
      // is restored here, and an id with no row is reported rather than dropped:
      // a chain's narrator ids are not foreign keys, so an unresolved reference
      // must be visible to the caller.
      return Effect.map(
        sqlEffect(
          sql,
          () =>
            sql`
              SELECT id, canonical_name_ar, name_variants, kunya, laqab, death_year,
                     tabaqa, reliability_by_critic, metadata
              FROM narrators
              WHERE id = ANY(${unique}::uuid[])
            ` as Promise<NarratorRow[]>,
        ),
        (rows): NarratorIdsLookup => {
          const byId = new Map(rows.map((row) => [row.id, rowToNarrator(row)]));
          const narrators: NarratorRecord[] = [];
          const missingIds: string[] = [];
          for (const id of unique) {
            const narrator = byId.get(id);
            if (narrator === undefined) missingIds.push(id);
            else narrators.push(narrator);
          }
          return { narrators, missingIds };
        },
      );
    },

    listChainsForChild(childId, opts) {
      if (opts.limit <= 0) return Effect.succeed([] as NarratorChainRecord[]);
      // Insertion order, never a grade ranking: several chains are presented to a
      // reader neutrally, so the store must not imply an authority order.
      return Effect.map(
        sqlEffect(
          sql,
          () =>
            sql`
              SELECT id, child_id, collection, narrator_ids, grade, grader, source_ref
              FROM narrator_chains
              WHERE child_id = ${childId}
              ORDER BY created_at, id
              LIMIT ${opts.limit}
            ` as Promise<ChainRow[]>,
        ),
        (rows) => rows.map(rowToChain),
      );
    },

    listChainsByCollection(collection, opts) {
      if (opts.limit <= 0) {
        return Effect.succeed({
          rows: [] as NarratorChainRecord[],
          nextAfterId: null,
        });
      }
      const afterId = opts.afterId ?? null;
      return Effect.map(
        sqlEffect(
          sql,
          () =>
            sql`
              SELECT id, child_id, collection, narrator_ids, grade, grader, source_ref
              FROM narrator_chains
              WHERE collection = ${collection}
                AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
              ORDER BY id
              LIMIT ${opts.limit}
            ` as Promise<ChainRow[]>,
        ),
        (rows) => ({
          rows: rows.map(rowToChain),
          // A short page is the end of the set; a full one may have more. The
          // caller's next request with this cursor settles it.
          nextAfterId: rows.length === opts.limit ? (rows.at(-1)?.id ?? null) : null,
        }),
      );
    },
  };
}
