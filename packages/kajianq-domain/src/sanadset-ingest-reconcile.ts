/**
 * Convergence for the pilot's own rows: what a run changes, and what it removes.
 *
 * A run owns exactly two row sets — the children under its parent document
 * (`sanadset/<collection>`) and the chains whose source address carries the
 * pilot's prefix — and it reconciles both against the plan it is about to write.
 * A child is identified by the digest of its immutable `text_raw`, never by its
 * ordinal: the ordinal is the database's upsert key, and reusing it for another
 * narration would pair one hadith's raw text with another's derived fields. A
 * child (or chain) the plan no longer contains is deleted in one transaction, so
 * a rerun leaves the store holding the plan, not the union of every plan ever
 * run. Narrator rows are left in the catalogue: they are keyed by identity and
 * shared by later runs, so an unreferenced row is not a stale transmission claim.
 *
 * The read is bounded. Both reads fail closed on their cap rather than reconcile
 * against a partial view — a truncated deletion could keep a row the plan dropped.
 */

import { Effect } from "effect";
import type { RagStore } from "@app/infra";
import { matnKeyOf } from "./sanadset-ingest-content";
import type { ChainPlan, NewChildPlan, PilotScope } from "./sanadset-ingest-plan-types";
import type { StoredChain, StoredChild } from "./sanadset-ingest-reconcile-state";

export {
  MAX_PILOT_CHAINS,
  MAX_PILOT_CHILDREN,
  PILOT_READ_PAGE,
  readPilotChains,
  readPilotChildren,
} from "./sanadset-ingest-reconcile-state";
export type { StoredChain, StoredChild } from "./sanadset-ingest-reconcile-state";

/** What a write did to one row set. `deleted` is the reconciliation's removal. */
export type WriteCounts = {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly deleted: number;
};

export type ChildUpsert = {
  readonly child: NewChildPlan;
  readonly ordinal: number;
  readonly textAr: string;
  readonly textId: string | null;
  readonly citation: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
};

export type ChildReconciliation = {
  readonly upserts: readonly ChildUpsert[];
  readonly counts: WriteCounts;
  readonly staleChildIds: readonly string[];
};

export type ChainUpsert = {
  readonly chain: ChainPlan;
  readonly childId: string;
  readonly narratorIds: readonly string[];
};

export type ChainReconciliation = {
  readonly upserts: readonly ChainUpsert[];
  readonly counts: WriteCounts;
  readonly stale: readonly { readonly collection: string; readonly sourceRef: string }[];
};

/** Deterministic JSON: object keys sorted, so a JSONB round-trip cannot fake a change. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** The child columns the plan derives for one new child. */
export function plannedChildFields(
  child: NewChildPlan,
  scope: PilotScope,
): Omit<ChildUpsert, "child" | "ordinal"> {
  return {
    textAr: child.textRaw,
    textId: null,
    citation: {
      sourceType: "hadith",
      collection: scope.collection,
      hadithNo: child.hadithNumber,
    },
    metadata: {
      sourceType: "hadith",
      collection: scope.collection,
      hadithNo: child.hadithNumber,
      ingestSource: "sanadset",
      book: scope.book,
      matnGroupId: child.groupId,
      sanadsetRowIndex: child.representativeRowIndex,
    },
  };
}

/**
 * Match planned children to stored ones by content digest and assign ordinals.
 *
 * A matched row keeps the ordinal it was first written with; a new child takes the
 * next ordinal above every stored one, so an insert can never land on a row the
 * plan did not address. A digest match whose stored raw text differs is a hash
 * collision: the run refuses rather than updating another narration's row.
 */
export function planChildWrites(
  children: readonly NewChildPlan[],
  stored: readonly StoredChild[],
  scope: PilotScope,
): ChildReconciliation {
  const byKey = new Map<string, StoredChild[]>();
  for (const row of stored) {
    const key = matnKeyOf(row.textRaw);
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, [row]);
    else bucket.push(row);
  }
  const used = new Set<string>();
  let highestOrdinal = stored.reduce((max, row) => Math.max(max, row.ordinal), -1);
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const upserts: ChildUpsert[] = [];

  for (const child of children) {
    const fields = plannedChildFields(child, scope);
    const match = (byKey.get(child.matnKey) ?? []).find((row) => !used.has(row.id));
    if (match !== undefined) {
      used.add(match.id);
      if (match.textRaw !== child.textRaw) {
        throw new Error(
          `child content key ${child.matnKey} matched stored child ${match.id} whose text_raw ` +
            "differs; refusing to pair immutable raw text with another narration's derived fields",
        );
      }
      const changed =
        match.textAr !== fields.textAr ||
        match.textId !== fields.textId ||
        !sameJson(match.citation, fields.citation) ||
        !sameJson(match.metadata, fields.metadata);
      if (changed) updated += 1;
      else unchanged += 1;
      upserts.push({ child, ordinal: match.ordinal, ...fields });
      continue;
    }
    highestOrdinal += 1;
    created += 1;
    upserts.push({ child, ordinal: highestOrdinal, ...fields });
  }

  const staleChildIds = stored.filter((row) => !used.has(row.id)).map((row) => row.id);
  return {
    upserts,
    counts: { created, updated, unchanged, deleted: staleChildIds.length },
    staleChildIds,
  };
}

/** Match planned chains to stored ones by source address; anything else is stale. */
export function planChainWrites(
  chains: readonly ChainUpsert[],
  stored: readonly StoredChain[],
): ChainReconciliation {
  const bySource = new Map(stored.map((row) => [row.sourceRef, row]));
  const planned = new Set<string>();
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const chain of chains) {
    const sourceRef = chain.chain.sourceRef;
    planned.add(sourceRef);
    const match = bySource.get(sourceRef);
    if (match === undefined) {
      created += 1;
      continue;
    }
    const same =
      match.childId === chain.childId &&
      match.narratorIds.length === chain.narratorIds.length &&
      match.narratorIds.every((id, index) => id === chain.narratorIds[index]) &&
      match.grade === null &&
      match.grader === null;
    if (same) unchanged += 1;
    else updated += 1;
  }

  const stale = stored
    .filter((row) => !planned.has(row.sourceRef))
    .map((row) => ({ collection: row.collection, sourceRef: row.sourceRef }));
  return {
    upserts: chains,
    counts: { created, updated, unchanged, deleted: stale.length },
    stale,
  };
}

/** Delete the rows the plan no longer contains, chains and children in one transaction. */
export async function deleteStaleRows(
  store: RagStore,
  childIds: readonly string[],
  chains: readonly { readonly collection: string; readonly sourceRef: string }[],
): Promise<{ readonly childrenDeleted: number; readonly chainsDeleted: number }> {
  if (childIds.length === 0 && chains.length === 0) {
    return { childrenDeleted: 0, chainsDeleted: 0 };
  }
  return Effect.runPromise(store.deleteCorpusRows({ childIds, chains }));
}
