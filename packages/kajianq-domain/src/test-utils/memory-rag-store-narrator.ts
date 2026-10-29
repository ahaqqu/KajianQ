import { Effect } from "effect";
import type { NarratorChainRecord, NarratorRecord, RagStore } from "@app/infra";

/**
 * Narrator/graph half of the in-memory RagStore, split from
 * `memory-rag-store.ts` to respect the agentic size limits — the same
 * concern-split the Postgres adapter uses (`rag-store-postgres-narrator.ts`).
 *
 * The double exists so unit tests can exercise the seam without a server, so it
 * must answer exactly what the adapter's SQL answers. Its ordering rules mirror
 * the adapter's comments: rows by `id` (the collation-free order both
 * implementations can guarantee), chains for a child by `(createdAt, id)`, a
 * collection page by the `id` cursor. Nothing is normalised or deduplicated
 * except the by-id lookup's own input, which the adapter also deduplicates.
 */

/** One seeded chain: the seam record plus the insertion time the neutral order reads. */
export type SeededChain = NarratorChainRecord & { readonly createdAt: number };

/** The maps the memory store owns (shared with the rest of the store's state). */
export type MemoryNarratorState = {
  narrators: Map<string, NarratorRecord>;
  chains: Map<string, SeededChain>;
};

/** The seam's four reads plus the seed/introspection helpers a test needs. */
export type MemoryNarratorMethods = Pick<
  RagStore,
  "findNarratorsByName" | "getNarratorsByIds" | "listChainsForChild" | "listChainsByCollection"
> & {
  seedNarrator: (narrator: NarratorRecord) => void;
  seedChain: (chain: SeededChain) => void;
  allNarrators: () => readonly NarratorRecord[];
  allChains: () => readonly SeededChain[];
};

/** The one comparison both stores' `id` order agrees on: plain string order. */
function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

export function memoryNarratorMethods(state: MemoryNarratorState): MemoryNarratorMethods {
  return {
    seedNarrator(narrator) {
      state.narrators.set(narrator.id, narrator);
    },
    seedChain(chain) {
      state.chains.set(chain.id, chain);
    },
    allNarrators: () => [...state.narrators.values()],
    allChains: () => [...state.chains.values()],

    findNarratorsByName(name, opts) {
      if (opts.limit <= 0 || name.trim() === "") return Effect.succeed([] as NarratorRecord[]);
      return Effect.sync(() =>
        [...state.narrators.values()]
          .filter(
            (narrator) => narrator.canonicalNameAr === name || narrator.nameVariants.includes(name),
          )
          .sort((left, right) => compareIds(left.id, right.id))
          .slice(0, opts.limit),
      );
    },

    getNarratorsByIds(ids) {
      const unique = [...new Set(ids)].filter((id) => id.trim() !== "");
      const narrators: NarratorRecord[] = [];
      const missingIds: string[] = [];
      for (const id of unique) {
        const narrator = state.narrators.get(id);
        if (narrator === undefined) missingIds.push(id);
        else narrators.push(narrator);
      }
      return Effect.succeed({ narrators, missingIds });
    },

    listChainsForChild(childId, opts) {
      if (opts.limit <= 0) return Effect.succeed([] as NarratorChainRecord[]);
      return Effect.sync(() =>
        [...state.chains.values()]
          .filter((chain) => chain.childId === childId)
          .sort((left, right) => left.createdAt - right.createdAt || compareIds(left.id, right.id))
          .slice(0, opts.limit)
          .map(stripInsertionTime),
      );
    },

    listChainsByCollection(collection, opts) {
      if (opts.limit <= 0) {
        return Effect.succeed({ rows: [] as NarratorChainRecord[], nextAfterId: null });
      }
      const afterId = opts.afterId;
      const rows = [...state.chains.values()]
        .filter((chain) => chain.collection === collection)
        .filter((chain) => afterId === undefined || compareIds(chain.id, afterId) > 0)
        .sort((left, right) => compareIds(left.id, right.id))
        .slice(0, opts.limit);
      return Effect.succeed({
        rows: rows.map(stripInsertionTime),
        nextAfterId: rows.length === opts.limit ? (rows.at(-1)?.id ?? null) : null,
      });
    },
  };
}

/** Drop the double's own insertion time: the seam record does not carry it. */
function stripInsertionTime({ createdAt: _createdAt, ...chain }: SeededChain): NarratorChainRecord {
  return chain;
}
