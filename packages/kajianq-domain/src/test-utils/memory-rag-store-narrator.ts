import { Effect } from "effect";
import {
  canonicalNarratorId,
  type NarratorChainRecord,
  type NarratorRecord,
  type RagStore,
} from "@app/infra";
import { assertGradeAttribution } from "../narrator";

/**
 * Narrator/graph half of the in-memory RagStore, split from
 * `memory-rag-store.ts` to respect the agentic size limits — the same
 * concern-split the Postgres adapter uses (`rag-store-postgres-narrator.ts`).
 *
 * The double exists so unit tests can exercise the seam without a server, so it
 * must answer exactly what the adapter's SQL answers. Its ordering rules mirror
 * the adapter's comments: rows by `id` (the collation-free order both
 * implementations can guarantee), chains for a child by the seeded insertion
 * sequence, a collection page by the `id` cursor. Id spelling is the only thing
 * canonicalised (a seeded narrator and a lookup's ids both use the adapter's
 * canonical form), and a seeded chain must carry the grade/grader pairing the
 * database's CHECK enforces.
 */

/** One seeded chain: the seam record plus the store-assigned insertion sequence. */
export type SeededChain = NarratorChainRecord & { readonly seq: number };

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
      // Postgres canonicalises a uuid's spelling on write; the double stores the
      // canonical form so a seeded row answers the same lookup the adapter does.
      const id = canonicalNarratorId(narrator.id);
      state.narrators.set(id, { ...narrator, id });
    },
    seedChain(chain) {
      // The memory double is the only DB-less write path a test sees; refusing a
      // row the database would reject is what keeps that gate from being greener
      // than the real store.
      assertGradeAttribution(chain.grade, chain.grader);
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
      const requested = new Map<string, string>();
      for (const raw of ids) {
        const canonical = canonicalNarratorId(raw);
        if (canonical !== "" && !requested.has(canonical)) requested.set(canonical, raw);
      }
      const narrators: NarratorRecord[] = [];
      const missingIds: string[] = [];
      for (const [canonical, original] of requested) {
        const narrator = state.narrators.get(canonical);
        if (narrator === undefined) missingIds.push(original);
        else narrators.push(narrator);
      }
      return Effect.succeed({ narrators, missingIds });
    },

    listChainsForChild(childId, opts) {
      if (opts.limit <= 0) return Effect.succeed([] as NarratorChainRecord[]);
      return Effect.sync(() =>
        [...state.chains.values()]
          .filter((chain) => chain.childId === childId)
          .sort((left, right) => left.seq - right.seq || compareIds(left.id, right.id))
          .slice(0, opts.limit)
          .map(stripInsertionSequence),
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
        rows: rows.map(stripInsertionSequence),
        nextAfterId: rows.length === opts.limit ? (rows.at(-1)?.id ?? null) : null,
      });
    },
  };
}

/** Drop the double's own insertion sequence: the seam record does not carry it. */
function stripInsertionSequence({ seq: _seq, ...chain }: SeededChain): NarratorChainRecord {
  return chain;
}
