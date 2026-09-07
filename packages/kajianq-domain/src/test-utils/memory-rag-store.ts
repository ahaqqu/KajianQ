import { Effect } from "effect";
import type {
  AlignedPairInsert,
  DocChildInsert,
  DocParentInsert,
  RagStore,
  SimilarChild,
} from "@app/infra";

/**
 * In-memory RagStore with real cosine-distance similarity search — the test
 * seam for ingestion + retrieval integration tests. Same upsert semantics as
 * the Neon adapter (parents by sourceKey, children by parent+ordinal, pairs
 * by pairKey), so idempotency assertions run against the real contract, and
 * similaritySearch ranks by genuine cosine distance, not stub ordering.
 *
 * Effect-signatured like the real seam (ADR-0027 decision 7): every method
 * returns `Effect<A, StoreError>` — test assertions stay Effect-shaped, not
 * bridge-shimmed.
 */
export function createMemoryRagStore(): RagStore & {
  /** All stored children (test introspection). */
  allChildren: () => DocChildInsert[];
  /** All stored parents (test introspection). */
  allParents: () => DocParentInsert[];
  /** All stored aligned pairs (test introspection). */
  allPairs: () => AlignedPairInsert[];
  /** Direct cosine search helper for assertions. */
  cosineSearch: (
    track: "primary" | "fallback",
    query: readonly number[],
    limit: number,
  ) => Promise<readonly SimilarChild[]>;
} {
  const parents = new Map<string, DocParentInsert & { id: string }>();
  const parentByKey = new Map<string, string>();
  const children = new Map<string, DocChildInsert & { id: string }>();
  const childByPos = new Map<string, string>();
  const pairs = new Map<string, AlignedPairInsert & { id: string }>();
  let seq = 0;

  const cosine = (a: readonly number[], b: readonly number[]): number => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += (a[i] ?? 0) * (b[i] ?? 0);
      na += (a[i] ?? 0) ** 2;
      nb += (b[i] ?? 0) ** 2;
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  };

  const store: RagStore = {
    insertDocParent(input) {
      return Effect.sync(() => {
        seq += 1;
        const existing = parentByKey.get(input.sourceKey);
        const id = existing ?? `p${seq}`;
        if (!existing) parentByKey.set(input.sourceKey, id);
        parents.set(id, { ...input, id });
        return id;
      });
    },
    insertDocChild(input) {
      return Effect.map(this.insertDocChildren([input]), (ids) => ids[0] ?? `c${(seq += 1)}`);
    },
    insertDocChildren(batch) {
      return Effect.sync(() => {
        const ids: string[] = [];
        for (const input of batch) {
          seq += 1;
          const key = `${input.parentId}:${input.ordinal}`;
          const existing = childByPos.get(key);
          const id = existing ?? `c${seq}`;
          if (!existing) childByPos.set(key, id);
          children.set(id, { ...input, id });
          ids.push(id);
        }
        return ids;
      });
    },
    upsertAlignedPair(input) {
      return Effect.sync(() => {
        seq += 1;
        const existing = pairs.get(input.pairKey);
        const id = existing?.id ?? `pair${seq}`;
        pairs.set(input.pairKey, { ...input, id });
        return id;
      });
    },
    similaritySearch(track, embedding, opts) {
      return Effect.sync(() => {
        const vec = track === "primary" ? "embeddingPrimary" : "embeddingFallback";
        const rows = [...children.values()]
          .filter((c) => c[vec] !== null && c[vec] !== undefined)
          .map((c) => ({
            child: {
              id: c.id,
              parentId: c.parentId,
              textRaw: c.textRaw,
              textAr: c.textAr,
              textId: c.textId ?? null,
              citation: c.citation ?? {},
              embeddingPrimary: c.embeddingPrimary ?? null,
              embeddingFallback: c.embeddingFallback ?? null,
              ordinal: c.ordinal,
              metadata: c.metadata ?? {},
              createdAt: 0,
            },
            distance: 1 - cosine(embedding, (c[vec] ?? []) as readonly number[]),
          }))
          .sort((a, b) => a.distance - b.distance)
          .slice(0, opts.limit)
          .map((hit, i) => ({ ...hit, rankDense: i + 1 }));
        return rows satisfies SimilarChild[];
      });
    },
    insertAnswerTrace() {
      return Effect.die(new Error("not needed in ingestion tests"));
    },
    getAnswerTraceByMessage() {
      return Effect.succeed(null);
    },
    createChatSession() {
      return Effect.die(new Error("not needed in ingestion tests"));
    },
    insertChatMessage() {
      return Effect.die(new Error("not needed in ingestion tests"));
    },
    createSession() {
      return Effect.die(new Error("not needed in ingestion tests"));
    },
    resolveUserId() {
      return Effect.succeed(null);
    },
    deleteUserCascade() {
      return Effect.void;
    },
    cleanupExpiredSessions() {
      return Effect.succeed(0);
    },
    insertEvalRun(input) {
      return Effect.succeed(input.id ?? `eval${(seq += 1)}`);
    },
  };

  return {
    ...store,
    allChildren: () => [...children.values()],
    allParents: () => [...parents.values()],
    allPairs: () => [...pairs.values()],
    cosineSearch: (track, query, limit) => Effect.runPromise(store.similaritySearch(track, query, { limit })),
  };
}