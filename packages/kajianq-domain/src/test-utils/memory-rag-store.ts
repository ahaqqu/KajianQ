import { Effect } from "effect";
import type {
  AlignedPairInsert,
  DocChildById,
  DocChildInsert,
  DocParentInsert,
  FeedbackInsert,
  RagStore,
  SimilarChild,
} from "@app/infra";
import { memoryEvalMethods } from "./memory-rag-store-eval";
import { memoryFeedbackMethods } from "./memory-rag-store-feedback";
import { memoryAuthMethods } from "./memory-rag-store-auth";

/**
 * In-memory RagStore with real cosine search — the test seam. Same upsert
 * semantics as the Neon adapter, Effect-signatured like the seam (ADR-0027).
 */

/** Project a stored child insert to the read shape: no vectors, epoch-0 createdAt. */
function toReadChild(
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

export function createMemoryRagStore(): RagStore & {
  allChildren: () => DocChildInsert[];
  allParents: () => DocParentInsert[];
  allPairs: () => AlignedPairInsert[];
  /** All persisted answer traces keyed by message id (test introspection). */
  allTraces: () => Map<string, unknown>;
  allChatMessages: () => readonly {
    sessionId: string;
    role: string;
    content: string;
    answerTraceId: string | null;
  }[];
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
  const traceOwners = new Map<string, string | null>(); // messageId → user (ADR-0007 amendment)
  const traceRowOwners = new Map<string, string | null>(); // trace row id → user
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
    insertAnswerTrace(input) {
      return Effect.sync(() => {
        traces.set(input.messageId, input.trace);
        traceRows.set(input.trace.id as string, input.trace); // row id = FK key
        traceOwners.set(input.messageId, input.userId);
        traceRowOwners.set(input.trace.id as string, input.userId);
        return input.trace.id;
      });
    },
    getAnswerTraceByMessage(messageId) {
      return Effect.succeed((traces.get(messageId) as never) ?? null);
    },
    getAnswerTraceById(id) {
      return Effect.succeed((traceRows.get(id) as never) ?? null);
    },
    createChatSession(input) {
      return Effect.sync(() => {
        const id = `sess${(seq += 1)}`;
        chatSessions.set(id, input.userId);
        return id;
      });
    },
    // A6: ownership validation for client-supplied session ids.
    getChatSessionUser(sessionId) {
      return Effect.succeed(chatSessions.get(sessionId) ?? null);
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
    // Follow-up context (#10): the session's tail, oldest first — insertion
    // order stands in for `created_at` (the memory store has no clock).
    getChatMessages(sessionId, opts) {
      return Effect.sync(() => {
        const limit = opts?.limit ?? 20;
        const all = [...chatMessages.entries()].map(([id, m], i) => ({
          id,
          sessionId: m.sessionId,
          role: m.role,
          content: m.content,
          answerTraceId: m.answerTraceId,
          createdAt: i,
        }));
        const tail = all.filter((m) => m.sessionId === sessionId).slice(-limit);
        return tail;
      });
    },
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
    allChatMessages: () => [...chatMessages.values()],
    allEvalResults: () => [...evalResults.values()],
    allFeedback: () => [...feedback.values()],
    cosineSearch: (track, query, limit) =>
      Effect.runPromise(store.similaritySearch(track, query, { limit })),
  };
}
