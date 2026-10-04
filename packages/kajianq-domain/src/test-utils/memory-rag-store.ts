import { Effect } from "effect";
import type {
  AlignedPairInsert,
  DocChildInsert,
  DocParentInsert,
  FeedbackInsert,
  RagStore,
  SimilarChild,
} from "@app/infra";
import {
  memoryAuthMethods,
  memoryChatMethods,
  memoryEvalMethods,
  memoryFeedbackMethods,
  memoryScopeMethods,
  toReadChild,
} from "./memory-rag-store-parts";

/**
 * In-memory RagStore with real cosine search — the test seam. Same upsert
 * semantics as the Postgres adapter, Effect-signatured like the seam (ADR-0027).
 */

export function createMemoryRagStore(): RagStore & {
  allChildren: () => DocChildInsert[];
  allParents: () => DocParentInsert[];
  allPairs: () => AlignedPairInsert[];
  /** All persisted answer traces keyed by message id (test introspection). */
  allTraces: () => Map<string, unknown>;
  allChatMessages: () => readonly {
    id: string;
    sessionId: string;
    role: string;
    content: string;
    answerTraceId: string | null;
  }[];
  /** All chat sessions by owning user (test introspection, #271). */
  allChatSessions: () => readonly { id: string; userId: string }[];
  allEvalResults: () => readonly {
    id: string;
    questionId: string;
    answerTraceId: string | null;
    outcome: unknown;
  }[];
  /** All persisted feedback rows (test introspection, #13). */
  allFeedback: () => readonly (FeedbackInsert & { id: string })[];
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
  const traceRows = new Map<string, unknown>();
  const traceOwners = new Map<string, string | null>(); // messageId → user (ADR-0007)
  const traceRowOwners = new Map<string, string | null>(); // trace row id → user
  const traceRowMessageIds = new Map<string, string>(); // trace row id → canonical messageId
  const feedback = new Map<string, FeedbackInsert & { id: string }>();
  // Chat/auth sessions are distinct maps, like the real tables (A5).
  const chatSessions = new Map<string, string>();
  const authSessions = new Map<string, { userId: string; expiresAt: number }>();
  const users = new Map<string, { kind: string }>();
  const tokens = new Map<string, string>(); // hash-standin → userId
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

  // The eval-ledger half lives in its own module, sharing this state.
  const evalState = {
    evalRuns,
    evalResults,
    nextId: () => (seq += 1),
  };
  const evalMethods = memoryEvalMethods(evalState);
  const feedbackMethods = memoryFeedbackMethods({
    chatMessages,
    traces,
    traceRows,
    traceOwners,
    traceRowOwners,
    traceRowMessageIds,
    feedback,
    nextId: () => (seq += 1),
  });
  const authMethods = memoryAuthMethods({
    users,
    authSessions,
    tokens,
    chatSessions,
    traces,
    traceOwners,
    feedback,
    nextId: () => (seq += 1),
  });
  // The chat half lives in its own module too, sharing the same two maps.
  const chatMethods = memoryChatMethods({ chatSessions, chatMessages });

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
            child: toReadChild(c),
            distance: 1 - cosine(embedding, (c[vec] ?? []) as readonly number[]),
          }))
          .sort((a, b) => a.distance - b.distance)
          .slice(0, opts.limit)
          .map((hit, i) => ({ ...hit, rankDense: i + 1 }));
        return rows satisfies SimilarChild[];
      });
    },
    getDocChildrenByIds(ids) {
      return Effect.sync(() =>
        [...new Set(ids)].flatMap((id) => {
          const c = children.get(id);
          if (!c) return [];
          const parent = parents.get(c.parentId);
          return [toReadChild(c, parent?.title ?? null)];
        }),
      );
    },
    // The bounded scope read (ADR-0045) — helper module, like the auth/eval
    // halves; the projection helper it shares with the reads above lives there.
    ...memoryScopeMethods({ parents, parentByKey, children }),
    countDocChildrenByMetadata(key) {
      return Effect.sync(() => {
        const counts = new Map<string | null, number>();
        for (const c of children.values()) {
          const raw = (c.metadata ?? {})[key];
          const value = typeof raw === "string" ? raw : null;
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        return [...counts.entries()]
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count);
      });
    },
    insertAnswerTrace(input) {
      return Effect.sync(() => {
        traces.set(input.messageId, input.trace);
        traceRows.set(input.trace.id as string, input.trace); // row id = FK key
        traceOwners.set(input.messageId, input.userId);
        traceRowOwners.set(input.trace.id as string, input.userId);
        traceRowMessageIds.set(input.trace.id as string, input.messageId); // canonical key (A2)
        return input.trace.id;
      });
    },
    getAnswerTraceByMessage(messageId) {
      return Effect.succeed((traces.get(messageId) as never) ?? null);
    },
    getAnswerTraceById(id) {
      return Effect.succeed((traceRows.get(id) as never) ?? null);
    },
    createChatSession: chatMethods.createChatSession,
    getChatSessionUser: chatMethods.getChatSessionUser,
    insertChatMessage: chatMethods.insertChatMessage,
    getChatMessages: chatMethods.getChatMessages,
    insertEvalRun: evalMethods.insertEvalRun,
    refreshEvalRun: evalMethods.refreshEvalRun,
    insertEvalResult: evalMethods.insertEvalResult,
    getEvalRun: evalMethods.getEvalRun,
    listEvalRuns: evalMethods.listEvalRuns,
    getEvalResultsByRun: evalMethods.getEvalResultsByRun,
    createSession: authMethods.createSession,
    resolveUserId: authMethods.resolveUserId,
    deleteUserCascade: authMethods.deleteUserCascade,
    cleanupExpiredSessions: authMethods.cleanupExpiredSessions,
    insertFeedback: feedbackMethods.insertFeedback,
    getAnswerFeedbackTarget: feedbackMethods.getAnswerFeedbackTarget,
  };

  return {
    ...store,
    allChildren: () => [...children.values()],
    allParents: () => [...parents.values()],
    allPairs: () => [...pairs.values()],
    allTraces: () => traces,
    allChatMessages: () => [...chatMessages.entries()].map(([id, m]) => ({ id, ...m })),
    /** Chat sessions by owning user, for "nothing was created" assertions (#271). */
    allChatSessions: () => [...chatSessions.entries()].map(([id, userId]) => ({ id, userId })),
    allEvalResults: () => [...evalResults.values()],
    allFeedback: () => [...feedback.values()],
    cosineSearch: (track, query, limit) =>
      Effect.runPromise(store.similaritySearch(track, query, { limit })),
  };
}
