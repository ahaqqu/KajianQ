/**
 * What the store already holds for the pilot, read page by page.
 *
 * Split from the reconciliation's planning so both stay inside the agentic size
 * limits. Both reads fail closed on their cap rather than reconcile against a
 * partial view — a truncated deletion could keep a row the plan dropped.
 */

import { Effect } from "effect";
import type { RagStore } from "@app/infra";

/** Rows per page while reading the pilot's own state. */
export const PILOT_READ_PAGE = 500;
/** Hard bound on the pilot's own child rows; a larger set refuses rather than truncates. */
export const MAX_PILOT_CHILDREN = 100_000;
/** Hard bound on the chains read from the pilot's collection. */
export const MAX_PILOT_CHAINS = 200_000;

export type StoredChild = {
  readonly id: string;
  readonly ordinal: number;
  readonly textRaw: string;
  readonly textAr: string;
  readonly textId: string | null;
  readonly citation: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
};

export type StoredChain = {
  readonly id: string;
  readonly childId: string;
  readonly collection: string;
  readonly narratorIds: readonly string[];
  readonly grade: string | null;
  readonly grader: string | null;
  readonly sourceRef: string;
};

/** Read every child the pilot's parent owns, in ordinal order. */
export async function readPilotChildren(
  store: RagStore,
  parentSourceKey: string,
): Promise<readonly StoredChild[]> {
  const rows: StoredChild[] = [];
  let fromOrdinal = 0;
  for (;;) {
    const page = await Effect.runPromise(
      store.listDocChildrenByParentSourceKey(parentSourceKey, {
        limit: PILOT_READ_PAGE,
        fromOrdinal,
      }),
    );
    for (const row of page) {
      rows.push({
        id: row.id,
        ordinal: row.ordinal,
        textRaw: row.textRaw,
        textAr: row.textAr,
        textId: row.textId,
        citation: row.citation,
        metadata: row.metadata,
      });
    }
    if (rows.length > MAX_PILOT_CHILDREN) {
      throw new Error(
        `the pilot's own child read passed ${MAX_PILOT_CHILDREN} rows; ` +
          "refusing to reconcile against a truncated view of its parent document",
      );
    }
    if (page.length < PILOT_READ_PAGE) return rows;
    const last = page.at(-1);
    if (last === undefined) return rows;
    fromOrdinal = last.ordinal + 1;
  }
}

/** Read the pilot's addressed chains from its collection, ignoring other producers'. */
export async function readPilotChains(
  store: RagStore,
  collection: string,
  sourceRefPrefix: string,
): Promise<readonly StoredChain[]> {
  const rows: StoredChain[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = await Effect.runPromise(
      store.listChainsByCollection(collection, {
        limit: PILOT_READ_PAGE,
        ...(afterId === undefined ? {} : { afterId }),
      }),
    );
    for (const row of page.rows) {
      if (row.sourceRef === null || !row.sourceRef.startsWith(sourceRefPrefix)) continue;
      rows.push({
        id: row.id,
        childId: row.childId,
        collection: row.collection,
        narratorIds: row.narratorIds,
        grade: row.grade,
        grader: row.grader,
        sourceRef: row.sourceRef,
      });
    }
    if (rows.length > MAX_PILOT_CHAINS) {
      throw new Error(
        `the pilot's chain read passed ${MAX_PILOT_CHAINS} rows; ` +
          "refusing to reconcile against a truncated view of its collection",
      );
    }
    if (page.nextAfterId === null) return rows;
    afterId = page.nextAfterId;
  }
}
