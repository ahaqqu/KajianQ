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
 * In-memory RagStore with real cosine search — the test seam. Upsert semantics
 * match the Postgres adapter; signatures match the seam.
 */

export function createMemoryRagStore(): RagStore & {
  allChildren: () => DocChildInsert[];
  allParents: () => DocParentInsert[];
  allPairs: () => AlignedPairInsert[];
  /** Answer traces keyed by message id (test introspection). */
  allTraces: () => Map<string, unknown>;
  allChatMessages: () => readonly {
    id: string;
    sessionId: string;
    role: string;
    content: string;
    answerTraceId: string | null;
  }[];
  allChatSessions: () => readonly { id: string; userId: string }[];
  allEvalResults: () => readonly {
    id: string;
    questionId: string;
    answerTraceId: string | null;
    outcome: unknown;
  }[];
  allFeedback: () => readonly (FeedbackInsert & { id: string })[];
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
  const traceOwners = new Map<string, string | null>(); // messageId → user
  const traceRowOwners = new Map<string, string | null>();
  const traceRowMessageIds = new Map<string, string>(); // trace row id → canonical messageId
  const feedback = new Map<string, FeedbackInsert & { id: string }>();
  // Chat and auth sessions are distinct maps, like the real tables.
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

  /**
   * The adapter binds each filter dimension as `metadata->>$k = ANY($v::text[])`,
   * so a row matches when the key's JSON *text* is one of the requested values: a
   * string matches itself, a number or boolean matches its text form, and a key
   * that is absent, JSON `null`, or an array/object matches nothing (its `->>` text
   * is `null` or the serialized JSON, which no single value equals). An empty or
   * absent filter record constrains nothing.
   */
  const matchesFilters = (
    metadata: Record<string, unknown>,
    filters: Record<string, string | readonly string[]> | undefined,
  ): boolean => {
    for (const [key, wanted] of Object.entries(filters ?? {})) {
      const values: readonly string[] = Array.isArray(wanted) ? wanted : [wanted as string];
      const raw = metadata[key];
      if (raw === undefined || raw === null) return false;
      const text =
        typeof raw === "string"
          ? raw
          : typeof raw === "number" || typeof raw === "boolean"
            ? String(raw)
            : JSON.stringify(raw);
      if (!values.includes(text)) return false;
    }
    return true;
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
          .filter((c) => matchesFilters(c.metadata ?? {}, opts.filters))
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
      // The adapter's read carries no ORDER BY — `WHERE c.id = ANY(...)` returns
      // whatever the plan yields — so the caller's array order is no contract.
      // Rows come back in the store's own order here: a test that leaned on the
      // order it passed in would pass against a promise the real read never makes.
      return Effect.sync(() => {
        const wanted = new Set(ids);
        return [...children.values()]
          .filter((c) => wanted.has(c.id))
          .map((c) => toReadChild(c, parents.get(c.parentId)?.title ?? null));
      });
    },
    // The bounded scope read: its helper module shares the read projection above.
    ...memoryScopeMethods({ parents, parentByKey, children }),
    countDocChildrenByMetadata(key) {
      return Effect.sync(() => {
        const counts = new Map<string, number>();
        for (const c of children.values()) {
          const raw = (c.metadata ?? {})[key];
          // The adapter counts only rows whose key exists AND holds a string
          // (`WHERE metadata ? $1 AND jsonb_typeof(metadata->$1) = 'string'`): a row
          // without a string value is absent from the result, not a `null` bucket.
          if (typeof raw !== "string") continue;
          counts.set(raw, (counts.get(raw) ?? 0) + 1);
        }
        // Equal counts sort by first appearance here; the adapter leaves their order
        // to the plan. Only the counts are a contract.
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
        traceRowMessageIds.set(input.trace.id as string, input.messageId); // canonical key
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
    allChatSessions: () => [...chatSessions.entries()].map(([id, userId]) => ({ id, userId })),
    allEvalResults: () => [...evalResults.values()],
    allFeedback: () => [...feedback.values()],
    cosineSearch: (track, query, limit) =>
      Effect.runPromise(store.similaritySearch(track, query, { limit })),
  };
}
