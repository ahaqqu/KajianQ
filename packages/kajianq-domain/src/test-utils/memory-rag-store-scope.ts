import { Effect } from "effect";
import type { DocChildById, DocChildInsert, DocParentInsert, RagStore } from "@app/infra";

/**
 * The in-memory store's child projection and its bounded parent-scoped read
 * (ADR-0045), split from `memory-rag-store.ts` to respect the agentic
 * 300-line cap — the same pattern as `memory-rag-store-auth.ts`. The caller
 * passes the store's own maps, so this module holds no state of its own.
 */

/** Project a stored child insert to the read shape: no vectors, epoch-0 createdAt. */
export function toReadChild(
  c: DocChildInsert & { id: string },
  parentTitle: string | null = null,
): DocChildById {
  return {
    id: c.id,
    parentId: c.parentId,
    textRaw: c.textRaw,
    textAr: c.textAr,
    textId: c.textId ?? null,
    citation: c.citation ?? {},
    embeddingPrimary: null,
    embeddingFallback: null,
    ordinal: c.ordinal,
    metadata: c.metadata ?? {},
    createdAt: 0,
    parentTitle,
  };
}

/** The store maps the parent-scoped read needs (owned by the caller). */
export type MemoryScopeState = {
  parents: Map<string, DocParentInsert & { id: string }>;
  parentByKey: Map<string, string>;
  children: Map<string, DocChildInsert & { id: string }>;
};

/**
 * The bounded scope read (ADR-0045) and the anchored neighbour read
 * (ADR-0049): the parent is addressed by its opaque `source_key` or by child
 * ids, rows come back in the same stable order the Postgres adapter uses
 * (`ordinal` ascending, id as tie-break), capped by `limit`. The two
 * implementations must agree — the memory store is the test seam the
 * retriever's own tests read through.
 */
export function memoryScopeMethods(state: MemoryScopeState): {
  listDocChildrenByParentSourceKey: RagStore["listDocChildrenByParentSourceKey"];
  listDocChildNeighboursByChildIds: RagStore["listDocChildNeighboursByChildIds"];
} {
  return {
    listDocChildrenByParentSourceKey(parentSourceKey, opts) {
      return Effect.sync(() => {
        if (opts.limit <= 0) return [] as readonly DocChildById[];
        const parentId = state.parentByKey.get(parentSourceKey);
        if (parentId === undefined) return [] as readonly DocChildById[];
        const parent = state.parents.get(parentId);
        return [...state.children.values()]
          .filter((c) => c.parentId === parentId)
          .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))
          .slice(0, opts.limit)
          .map((c) => toReadChild(c, parent?.title ?? null));
      });
    },

    listDocChildNeighboursByChildIds(anchorChildIds, opts) {
      return Effect.sync(() => {
        if (opts.radius <= 0 || opts.limit <= 0) return [] as readonly DocChildById[];
        const seen = new Set<string>();
        const anchors: { anchorPos: number; parentId: string; ordinal: number }[] = [];
        for (const id of anchorChildIds) {
          if (id.trim() === "" || seen.has(id)) continue;
          seen.add(id);
          const row = state.children.get(id);
          if (row === undefined) continue;
          anchors.push({ anchorPos: anchors.length, parentId: row.parentId, ordinal: row.ordinal });
        }
        const windows = new Map<
          string,
          { anchorPos: number; row: DocChildInsert & { id: string } }
        >();
        for (const anchor of anchors) {
          for (const row of state.children.values()) {
            if (row.parentId !== anchor.parentId) continue;
            if (Math.abs(row.ordinal - anchor.ordinal) > opts.radius) continue;
            if (seen.has(row.id)) continue;
            const existing = windows.get(row.id);
            if (existing === undefined || anchor.anchorPos < existing.anchorPos) {
              windows.set(row.id, { anchorPos: anchor.anchorPos, row });
            }
          }
        }
        return [...windows.values()]
          .sort(
            (a, b) =>
              a.anchorPos - b.anchorPos ||
              a.row.ordinal - b.row.ordinal ||
              a.row.id.localeCompare(b.row.id),
          )
          .slice(0, opts.limit)
          .map((w) => toReadChild(w.row, state.parents.get(w.row.parentId)?.title ?? null));
      });
    },
  };
}
