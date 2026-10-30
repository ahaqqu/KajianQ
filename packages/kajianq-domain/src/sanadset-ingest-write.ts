/**
 * The write path: turn one plan into store rows, or refuse.
 *
 * Two properties make it safe to run twice. Narrators are upserted by the plan's
 * identity keys, so a re-run returns the rows it already wrote; children are
 * upserted by `(parent, ordinal)` with the ordinal the plan fixed, and chains by
 * their source address, so no second copy can appear. Nothing here derives a key
 * from the run id: a new run over the same archive converges on the same rows.
 *
 * The gate is checked twice by construction — the orchestrator checks it before
 * reading anything, and this function checks it again before the first write — so
 * a caller that forgets cannot write. A dry run never reaches this module.
 */

import { Effect } from "effect";
import type { RagStore } from "@app/infra";
import type { IngestPlan } from "./sanadset-ingest-plan";
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
  readonly childrenCreated: number;
  readonly chainsWritten: number;
  readonly narratorsWritten: number;
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

  const narratorIds = new Map<string, string>();
  for (const narrator of plan.narrators.narrators) {
    const record = await Effect.runPromise(
      store.upsertNarrator({
        identityKey: narrator.identityKey,
        canonicalNameAr: narrator.canonical,
        nameVariants: [...narrator.variants],
        metadata: {
          identityBasis: plan.narrators.identityBasis,
          foldedName: narrator.folded,
          mentions: narrator.mentions,
        },
      }),
    );
    narratorIds.set(narrator.folded, record.id);
  }

  let parentId: string | null = null;
  const childIdByGroup = new Map<number, string>();
  for (const group of plan.groups) {
    if (group.target.kind === "existing") childIdByGroup.set(group.groupId, group.target.childId);
  }
  if (plan.children.created.length > 0) {
    parentId = await Effect.runPromise(
      store.insertDocParent({
        sourceKey: pilotParentSourceKey(scope.collection),
        title: COLLECTION_TITLES[scope.collection] ?? `Sanadset — ${scope.collection}`,
        metadata: {
          sourceType: "hadith",
          collection: scope.collection,
          ingestSource: "sanadset",
          book: scope.book,
        },
      }),
    );
    const created = plan.children.created;
    for (let start = 0; start < created.length; start += CHILD_INSERT_CHUNK) {
      const chunk = created.slice(start, start + CHILD_INSERT_CHUNK);
      const ids = await Effect.runPromise(
        store.insertDocChildren(
          chunk.map((child) => ({
            parentId: parentId as string,
            textRaw: child.textRaw,
            textAr: child.textRaw,
            textId: null,
            citation: {
              sourceType: "hadith",
              collection: scope.collection,
              hadithNo: child.hadithNumber,
            },
            embeddingPrimary: null,
            embeddingFallback: null,
            ordinal: child.ordinal,
            metadata: {
              sourceType: "hadith",
              collection: scope.collection,
              hadithNo: child.hadithNumber,
              ingestSource: "sanadset",
              book: scope.book,
              matnGroupId: child.groupId,
              sanadsetRowIndex: child.representativeRowIndex,
            },
          })),
        ),
      );
      if (ids.length !== chunk.length) {
        throw new Error(
          `insertDocChildren returned ${ids.length} ids for ${chunk.length} children: ` +
            "the store's upsert order is the caller's input order",
        );
      }
      for (const [index, child] of chunk.entries()) {
        childIdByGroup.set(child.groupId, ids[index] as string);
      }
    }
  }

  const chains = plan.chains.map((chain) => {
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
    return {
      childId,
      collection: scope.collection,
      narratorIds: narratorIdsForChain,
      grade: null,
      grader: null,
      sourceRef: chain.sourceRef,
    };
  });
  if (chains.length > 0) await Effect.runPromise(store.insertNarratorChains(chains));

  return {
    parentId,
    childrenCreated: plan.children.created.length,
    chainsWritten: chains.length,
    narratorsWritten: plan.narrators.narrators.length,
  };
}
