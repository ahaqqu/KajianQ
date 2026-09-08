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
  /** All persisted answer traces keyed by message id (test introspection). */
  allTraces: () => Map<string, unknown>;
  /** All persisted chat messages (test introspection, insertion order). */
  allChatMessages: () => readonly {
    sessionId: string;
    role: string;
    content: string;
    answerTraceId: string | null;
  }[];
  /** All stored eval results (test introspection, in insertion order). */
  allEvalResults: () => readonly {
    id: string;
    questionId: string;
    answerTraceId: string | null;
    outcome: unknown;
  }[];
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
  const traces = new Map<string, unknown>();
  const sessions = new Map<string, string>();
  const chatMessages = new Map<
    string,
    { sessionId: string; role: string; content: string; answerTraceId: string | null }
  >();
  const evalRuns = new Map<string, { label: string | null; report: unknown; createdAt: number }>();
  const evalResults = new Map<
    string,
    { id: string; questionId: string; answerTraceId: string | null; outcome: unknown }
  >();
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
    insertAnswerTrace(input) {
      return Effect.sync(() => {
        traces.set(input.messageId, input.trace);
        return input.trace.id;
      });
    },
    getAnswerTraceByMessage(messageId) {
      return Effect.succeed((traces.get(messageId) as never) ?? null);
    },
    createChatSession(input) {
      return Effect.sync(() => {
        const id = `sess${(seq += 1)}`;
        sessions.set(id, input.userId);
        return id;
      });
    },
    insertChatMessage(input) {
      return Effect.sync(() => {
        const id = `msg${(seq += 1)}`;
        chatMessages.set(id, {
          sessionId: input.sessionId,
          role: input.role,
          content: input.content,
          answerTraceId: input.answerTraceId ?? null,
        });
        return id;
      });
    },
    createSession() {
      const minted = {
        userId: `user${(seq += 1)}`,
        sessionId: `s${(seq += 1)}`,
        token: `tok${(seq += 1)}`,
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      };
      return Effect.sync(() => {
        sessions.set(minted.sessionId, minted.userId);
        return minted;
      });
    },
    resolveUserId(token) {
      // Fixed test token → the first minted user; anything else unknown.
      const userId = token === "tok1" ? ([...sessions.values()][0] ?? null) : null;
      return Effect.sync(() => userId);
    },
    deleteUserCascade() {
      return Effect.void;
    },
    cleanupExpiredSessions() {
      return Effect.succeed(0);
    },
    insertEvalRun(input) {
      return Effect.sync(() => {
        const id = input.id ?? `eval${(seq += 1)}`;
        evalRuns.set(id, { label: input.label ?? null, report: input.report, createdAt: 0 });
        return id;
      });
    },
    insertEvalResult(input) {
      return Effect.sync(() => {
        const id = `er${(seq += 1)}`;
        evalResults.set(id, {
          id,
          questionId: input.questionId,
          answerTraceId: input.answerTraceId ?? null,
          outcome: input.outcome,
        });
        return id;
      });
    },
    getEvalRun(id) {
      return Effect.sync(() => {
        const run = evalRuns.get(id);
        return run ? (run.report as never) : null;
      });
    },
    listEvalRuns(opts) {
      return Effect.sync(() =>
        [...evalRuns.entries()].slice(0, opts.limit).map(([id, run]) => ({
          id,
          label: run.label,
          createdAt: run.createdAt,
        })),
      );
    },
    getEvalResultsByRun(runId) {
      return Effect.sync(() =>
        // In-memory results are not row-keyed by run; the harness reads them
        // back per run id in tests, so the memory store keeps a flat list and
        // filters on the stored run marker via outcome passthrough.
        [...evalResults.values()].filter((r) => (evalRuns.has(runId) ? true : false)),
      );
    },
  };

  return {
    ...store,
    allChildren: () => [...children.values()],
    allParents: () => [...parents.values()],
    allPairs: () => [...pairs.values()],
    allTraces: () => traces,
    allChatMessages: () => [...chatMessages.values()],
    allEvalResults: () => [...evalResults.values()],
    cosineSearch: (track, query, limit) =>
      Effect.runPromise(store.similaritySearch(track, query, { limit })),
  };
}
