/**
 * The write path: turn one plan into store rows, converge that source's rows, or refuse.
 *
 * Two properties make it safe to run twice. Narrators are upserted by the plan's
 * identity keys, so a re-run returns the rows it already wrote; children are keyed
 * by the digest of their immutable raw matn, so a reordered plan reaches the row it
 * wrote before instead of pairing one hadith's raw text with another's citation;
 * chains are keyed by their source address. Nothing derives a key from the run id:
 * a new run over the same archive converges on the same rows.
 *
 * A run also removes what its plan no longer contains — the pilot's own children
 * whose matn content is gone from the plan, and its addressed chains whose source
 * row is gone or now quarantined — in one transaction, after the upserts. Without
 * that step the store would hold the union of every plan ever run.
 *
 * The gate is checked twice by construction — the orchestrator checks it before
 * reading anything, and this function checks it again before the first write — so
 * a caller that forgets cannot write. A dry run never reaches this module.
 */

import { Effect } from "effect";
import type { RagStore } from "@app/infra";
import { PILOT_CHAIN_SOURCE_PREFIX, type IngestPlan } from "./sanadset-ingest-plan-types";
import {
  deleteStaleRows,
  planChildWrites,
  planChainWrites,
  readPilotChildren,
  readPilotChains,
  type ChainUpsert,
  type WriteCounts,
} from "./sanadset-ingest-reconcile";
import { assertIngestGate, type IngestGateDecision } from "./sanadset-snapshot-gate";

/** The pilot's parent document: one per collection, stable across runs. */
export const PILOT_PARENT_SOURCE_KEY_PREFIX = "sanadset";
const COLLECTION_TITLES: Readonly<Record<string, string>> = {
  bukhari: "Sanadset — Bukhari",
};

/** Children per upsert call: bounded so one statement stays under the parameter cap. */
export const CHILD_INSERT_CHUNK = 500;

export type WriteOutcome = {
  readonly parentId: string | null;
  readonly children: WriteCounts;
  readonly chains: WriteCounts;
  /** Name-cluster rows upserted; the catalogue is not reconciled (see the module note). */
  readonly narratorsUpserted: number;
};

/** The parent's provenance key for one collection, e.g. `sanadset/bukhari`. */
export function pilotParentSourceKey(collection: string): string {
  return `${PILOT_PARENT_SOURCE_KEY_PREFIX}/${collection}`;
}

export type ExecutePlanOptions = {
  readonly store: RagStore;
  readonly plan: IngestPlan;
  readonly gate: IngestGateDecision;
};

export async function executeIngestPlan(options: ExecutePlanOptions): Promise<WriteOutcome> {
  assertIngestGate(options.gate);
  if (options.gate.mode === "dry-run") {
    throw new Error("executeIngestPlan: a dry run has no write path");
  }
  const { store, plan } = options;
  const { scope } = plan;
  const parentSourceKey = pilotParentSourceKey(scope.collection);

  // Read the pilot's own state before writing: the plan owns these rows, and the
  // comparison against them decides created/updated/unchanged and what is stale.
  const storedChildren = await readPilotChildren(store, parentSourceKey);
  const storedChains = await readPilotChains(store, scope.collection, PILOT_CHAIN_SOURCE_PREFIX);

  const narratorIds = new Map<string, string>();
  for (const narrator of plan.narrators.narrators) {
    const record = await Effect.runPromise(
      store.upsertNarrator({
        identityKey: narrator.identityKey,
        canonicalNameAr: narrator.canonical,
        nameVariants: [...narrator.variants],
        metadata: {
          identityBasis: plan.narrators.identityBasis,
          nameCluster: true,
          foldedName: narrator.folded,
          mentions: narrator.mentions,
          rawSpellings: narrator.variants.length + 1,
        },
      }),
    );
    narratorIds.set(narrator.folded, record.id);
  }

  const childPlan = planChildWrites(plan.children.created, storedChildren, scope);
  let parentId: string | null = null;
  const childIdByGroup = new Map<number, string>();
  for (const group of plan.groups) {
    if (group.target.kind === "existing") childIdByGroup.set(group.groupId, group.target.childId);
  }
  if (childPlan.upserts.length > 0) {
    parentId = await Effect.runPromise(
      store.insertDocParent({
        sourceKey: parentSourceKey,
        title: COLLECTION_TITLES[scope.collection] ?? `Sanadset — ${scope.collection}`,
        metadata: {
          sourceType: "hadith",
          collection: scope.collection,
          ingestSource: "sanadset",
          book: scope.book,
        },
      }),
    );
    for (let start = 0; start < childPlan.upserts.length; start += CHILD_INSERT_CHUNK) {
      const chunk = childPlan.upserts.slice(start, start + CHILD_INSERT_CHUNK);
      const ids = await Effect.runPromise(
        store.insertDocChildren(
          chunk.map((entry) => ({
            parentId: parentId as string,
            textRaw: entry.child.textRaw,
            textAr: entry.textAr,
            textId: entry.textId,
            citation: entry.citation,
            embeddingPrimary: null,
            embeddingFallback: null,
            ordinal: entry.ordinal,
            metadata: entry.metadata,
          })),
        ),
      );
      if (ids.length !== chunk.length) {
        throw new Error(
          `insertDocChildren returned ${ids.length} ids for ${chunk.length} children: ` +
            "the store's upsert order is the caller's input order",
        );
      }
      for (const [index, entry] of chunk.entries()) {
        childIdByGroup.set(entry.child.groupId, ids[index] as string);
      }
    }
  }

  const chainUpserts: ChainUpsert[] = plan.chains.map((chain) => {
    const childId = childIdByGroup.get(chain.groupId);
    if (childId === undefined) {
      throw new Error(`chain for row ${chain.rowIndex} has no child to attach to`);
    }
    const narratorIdsForChain = chain.foldedChain.map((folded) => {
      const id = narratorIds.get(folded);
      if (id === undefined) {
        throw new Error(`chain for row ${chain.rowIndex} names an unplanned narrator "${folded}"`);
      }
      return id;
    });
    return { chain, childId, narratorIds: narratorIdsForChain };
  });
  if (chainUpserts.length > 0) {
    await Effect.runPromise(
      store.insertNarratorChains(
        chainUpserts.map((entry) => ({
          childId: entry.childId,
          collection: scope.collection,
          narratorIds: entry.narratorIds,
          grade: null,
          grader: null,
          sourceRef: entry.chain.sourceRef,
        })),
      ),
    );
  }

  const chainPlan = planChainWrites(chainUpserts, storedChains);
  const deleted = await deleteStaleRows(store, childPlan.staleChildIds, chainPlan.stale);
  if (deleted.childrenDeleted !== childPlan.staleChildIds.length) {
    throw new Error(
      `reconciliation deleted ${deleted.childrenDeleted} of ${childPlan.staleChildIds.length} ` +
        "stale children; the store's delete did not address the rows the read returned",
    );
  }

  return {
    parentId,
    children: { ...childPlan.counts, deleted: deleted.childrenDeleted },
    chains: { ...chainPlan.counts, deleted: deleted.chainsDeleted },
    narratorsUpserted: plan.narrators.narrators.length,
  };
}
