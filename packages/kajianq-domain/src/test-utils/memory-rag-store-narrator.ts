import { Effect } from "effect";
import {
  canonicalNarratorId,
  chainWriteProblem,
  narratorWriteProblem,
  StoreError,
  type NarratorChainInsert,
  type NarratorChainRecord,
  type NarratorRecord,
  type NarratorUpsert,
  type RagStore,
} from "@app/infra";
import { assertGradeAttribution } from "../narrator";

/**
 * Narrator/graph half of the in-memory RagStore, split from
 * `memory-rag-store.ts` to respect the agentic size limits — the same
 * concern-split the Postgres adapter uses (`rag-store-postgres-narrator.ts`,
 * `-narrator-write.ts`).
 *
 * The double exists so unit tests can exercise the seam without a server, so it
 * must answer exactly what the adapter's SQL answers. Its ordering rules mirror
 * the adapter's comments: rows by `id` (the collation-free order both
 * implementations can guarantee), chains for a child by the seeded insertion
 * sequence, a collection page by the `id` cursor. Id spelling is the only thing
 * canonicalised (a seeded narrator and a lookup's ids both use the adapter's
 * canonical form), and a seeded chain must carry the grade/grader pairing the
 * database's CHECK enforces.
 *
 * The write half keeps the same fidelity: it calls the seam's own pre-flight
 * predicates, so a row the adapter would refuse as a `constraint` error is
 * refused here too, and it maintains the same two natural-key maps the database's
 * unique indexes implement — `identity_key` for narrators, `(collection,
 * sourceRef)` for chains. A seeded row with a source address registers that
 * address, so a later upsert of it updates the seeded row exactly as it would in
 * PostgreSQL.
 */

/** One seeded chain: the seam record plus the store-assigned insertion sequence. */
export type SeededChain = NarratorChainRecord & { readonly seq: number };

/** The maps the memory store owns (shared with the rest of the store's state). */
export type MemoryNarratorState = {
  narrators: Map<string, NarratorRecord>;
  chains: Map<string, SeededChain>;
  /** Identity key -> narrator id, the map `narrators_identity_key_idx` encodes. */
  narratorKeys?: Map<string, string>;
  /** `collection\u0000sourceRef` -> chain id, the map `narrator_chains_source_ref_idx` encodes. */
  chainKeys?: Map<string, string>;
};

/** The seam's reads and writes plus the seed/introspection helpers a test needs. */
export type MemoryNarratorMethods = Pick<
  RagStore,
  | "findNarratorsByName"
  | "getNarratorsByIds"
  | "listChainsForChild"
  | "listChainsByCollection"
  | "upsertNarrator"
  | "insertNarratorChains"
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

/** The database's natural key for one chain row, as one map key. */
function chainKey(collection: string, sourceRef: string | null): string | null {
  return sourceRef === null ? null : `${collection}\u0000${sourceRef}`;
}

function reject(problem: string): Effect.Effect<never, StoreError> {
  return Effect.fail(new StoreError({ kind: "constraint", cause: new Error(problem) }));
}

export function memoryNarratorMethods(state: MemoryNarratorState): MemoryNarratorMethods {
  const narratorKeys = (state.narratorKeys ??= new Map<string, string>());
  const chainKeys = (state.chainKeys ??= new Map<string, string>());
  let highestSeq: number | null = null;
  const nextSeq = (): number => {
    highestSeq ??= [...state.chains.values()].reduce((max, chain) => Math.max(max, chain.seq), 0);
    highestSeq += 1;
    return highestSeq;
  };

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
      const key = chainKey(chain.collection, chain.sourceRef);
      if (key !== null && chainKeys.has(key)) {
        throw new Error(`seeded chain '${chain.sourceRef}' duplicates a stored source address`);
      }
      state.chains.set(chain.id, chain);
      if (key !== null) chainKeys.set(key, chain.id);
      if (highestSeq !== null) highestSeq = Math.max(highestSeq, chain.seq);
    },
    allNarrators: () => [...state.narrators.values()],
    allChains: () => [...state.chains.values()],

    upsertNarrator(input: NarratorUpsert) {
      const problem = narratorWriteProblem(input);
      if (problem !== null) return reject(problem);
      const existingId = narratorKeys.get(input.identityKey);
      const existing = existingId === undefined ? undefined : state.narrators.get(existingId);
      if (existing !== undefined) {
        // The canonical spelling is fixed at first write; a later spelling is a
        // variant. The union preserves the recorded order, matching the SQL's
        // `existing || unrecorded`.
        const variants = [...existing.nameVariants];
        for (const variant of input.nameVariants ?? []) {
          if (!variants.includes(variant)) variants.push(variant);
        }
        const merged: NarratorRecord = {
          ...existing,
          nameVariants: variants,
          kunya: existing.kunya ?? input.kunya ?? null,
          laqab: existing.laqab ?? input.laqab ?? null,
          deathYear: existing.deathYear ?? input.deathYear ?? null,
          tabaqa: existing.tabaqa ?? input.tabaqa ?? null,
          reliabilityByCritic: {
            ...existing.reliabilityByCritic,
            ...input.reliabilityByCritic,
          },
          metadata: { ...existing.metadata, ...input.metadata },
        };
        state.narrators.set(existing.id, merged);
        return Effect.succeed(merged);
      }
      const id = crypto.randomUUID();
      const created: NarratorRecord = {
        id,
        canonicalNameAr: input.canonicalNameAr,
        nameVariants: [...(input.nameVariants ?? [])],
        kunya: input.kunya ?? null,
        laqab: input.laqab ?? null,
        deathYear: input.deathYear ?? null,
        tabaqa: input.tabaqa ?? null,
        reliabilityByCritic: { ...input.reliabilityByCritic },
        metadata: { ...input.metadata },
      };
      state.narrators.set(id, created);
      narratorKeys.set(input.identityKey, id);
      return Effect.succeed(created);
    },

    insertNarratorChains(rows: readonly NarratorChainInsert[]) {
      for (const row of rows) {
        const problem = chainWriteProblem(row);
        if (problem !== null) return reject(problem);
      }
      const ids: string[] = [];
      for (const row of rows) {
        const key = chainKey(row.collection, row.sourceRef);
        const existingId = key === null ? undefined : chainKeys.get(key);
        const existing = existingId === undefined ? undefined : state.chains.get(existingId);
        const grade = row.grade ?? null;
        const grader = row.grader ?? null;
        if (existing !== undefined) {
          // The natural key moves the row: a re-run refreshes its child and its
          // ordered narrator sequence, while the store-assigned `seq` (the read's
          // neutral order) stays the one the first write received.
          state.chains.set(existing.id, {
            ...existing,
            childId: row.childId,
            narratorIds: [...row.narratorIds],
            grade,
            grader,
            sourceRef: row.sourceRef,
          });
          ids.push(existing.id);
          continue;
        }
        const id = crypto.randomUUID();
        state.chains.set(id, {
          id,
          childId: row.childId,
          collection: row.collection,
          narratorIds: [...row.narratorIds],
          grade,
          grader,
          sourceRef: row.sourceRef,
          seq: nextSeq(),
        });
        if (key !== null) chainKeys.set(key, id);
        ids.push(id);
      }
      return Effect.succeed(ids as readonly string[]);
    },

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
