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
 * The bounded scope read (ADR-0045): the parent is addressed by its opaque
 * `source_key`, rows come back in the same stable order the Postgres adapter
 * uses (`ordinal` ascending, id as tie-break), capped by `limit`.
 */
export function memoryScopeMethods(state: MemoryScopeState): {
  listDocChildrenByParentSourceKey: RagStore["listDocChildrenByParentSourceKey"];
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
  };
}
