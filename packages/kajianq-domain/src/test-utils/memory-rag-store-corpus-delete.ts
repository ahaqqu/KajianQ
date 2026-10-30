import { Effect } from "effect";
import type { RagStore } from "@app/infra";
import type { MemoryNarratorState } from "./memory-rag-store-narrator";

/**
 * The deletion half of the in-memory store's convergence step, split from
 * `memory-rag-store.ts` to respect the agentic size limits.
 *
 * The order mirrors the adapter's transaction: addressed chains are removed and
 * counted first, then the child sweep removes rows and cascades whatever chain a
 * stale child still held. Deleting a child is only complete when its position and
 * its chains are gone, so the three maps move together.
 */
export function memoryCorpusDeletionMethods<Child extends { parentId: string; ordinal: number }>(
  narratorState: MemoryNarratorState,
  children: Map<string, Child>,
  childByPos: Map<string, string>,
): Pick<RagStore, "deleteCorpusRows"> {
  return {
    deleteCorpusRows(input) {
      return Effect.sync(() => {
        const chainKeys = (narratorState.chainKeys ??= new Map());
        let chainsDeleted = 0;
        for (const address of input.chains) {
          const key = `${address.collection}\u0000${address.sourceRef}`;
          const chainId = chainKeys.get(key);
          if (chainId === undefined) continue;
          chainKeys.delete(key);
          if (narratorState.chains.delete(chainId)) chainsDeleted += 1;
        }

        let childrenDeleted = 0;
        for (const id of input.childIds) {
          const row = children.get(id);
          if (row === undefined) continue;
          childByPos.delete(`${row.parentId}:${row.ordinal}`);
          children.delete(id);
          childrenDeleted += 1;
        }

        // The foreign key's cascade: a chain attached to a deleted child dies with it.
        const deletedChildren = new Set(input.childIds);
        for (const [id, chain] of [...narratorState.chains]) {
          if (!deletedChildren.has(chain.childId)) continue;
          narratorState.chains.delete(id);
          if (chain.sourceRef !== null) {
            const key = `${chain.collection}\u0000${chain.sourceRef}`;
            if (chainKeys.get(key) === id) chainKeys.delete(key);
          }
        }
        return { childrenDeleted, chainsDeleted };
      });
    },
  };
}
