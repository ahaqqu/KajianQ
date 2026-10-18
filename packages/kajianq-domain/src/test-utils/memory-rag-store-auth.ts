import { Effect } from "effect";
import type { RagStore } from "@app/infra";

/**
 * Anonymous-session methods of the in-memory RagStore (ADR-0017), split from
 * `memory-rag-store.ts` to respect the agentic size limits — same pattern as
 * `memory-rag-store-eval.ts` / `memory-rag-store-feedback.ts`. The maps are
 * owned by the main factory and shared here by reference. Cleanup and cascade
 * semantics mirror the Postgres adapter's contract: expired sessions AND the
 * anonymous users left with no session, one call, reclaimed user count
 * returned; the cascade removes the user's full subtree — chat sessions and
 * their messages, answer traces (both the message-keyed and the row-keyed maps),
 * and feedback — so a route test can assert the same emptiness the adapter's
 * postcondition asserts.
 */
export type MemoryAuthState = {
  users: Map<string, { kind: string }>;
  authSessions: Map<string, { userId: string; expiresAt: number }>;
  /** Hash-standin token → userId. */
  tokens: Map<string, string>;
  chatSessions: Map<string, string>;
  chatMessages: Map<
    string,
    { sessionId: string; role: string; content: string; answerTraceId: string | null }
  >;
  /** Traces by message id, plus their owners (ADR-0007). */
  traces: Map<string, unknown>;
  traceOwners: Map<string, string | null>;
  /** The same traces by their stored row id — what rehydration reads. */
  traceRows: Map<string, unknown>;
  traceRowOwners: Map<string, string | null>;
  traceRowMessageIds: Map<string, string>;
  feedback: Map<string, { userId: string | null }>;
  nextId: () => number;
};

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Remove one user's whole subtree — what `users` plus its `ON DELETE CASCADE`
 * fan-out does in Postgres. Chat messages go with their owning chat session
 * (their owner is transitive), traces go from both maps, feedback goes by owner.
 */
function eraseSubtree(state: MemoryAuthState, userId: string): void {
  state.users.delete(userId);
  for (const [id, owner] of [...state.chatSessions]) {
    if (owner !== userId) continue;
    state.chatSessions.delete(id);
    for (const [messageId, message] of [...state.chatMessages]) {
      if (message.sessionId === id) state.chatMessages.delete(messageId);
    }
  }
  for (const [id, session] of [...state.authSessions]) {
    if (session.userId === userId) state.authSessions.delete(id);
  }
  // The token is the session credential: erasing the sessions must retire it,
  // or `resolveUserId` would keep resolving a token whose row is gone.
  for (const [token, owner] of [...state.tokens]) {
    if (owner === userId) state.tokens.delete(token);
  }
  for (const [messageId, owner] of [...state.traceOwners]) {
    if (owner === userId) {
      state.traces.delete(messageId);
      state.traceOwners.delete(messageId);
    }
  }
  for (const [rowId, owner] of [...state.traceRowOwners]) {
    if (owner === userId) {
      state.traceRows.delete(rowId);
      state.traceRowOwners.delete(rowId);
      state.traceRowMessageIds.delete(rowId);
    }
  }
  for (const [id, row] of [...state.feedback]) {
    if (row.userId === userId) state.feedback.delete(id);
  }
}

export function memoryAuthMethods(
  state: MemoryAuthState,
): Pick<
  RagStore,
  "createSession" | "resolveUserId" | "deleteUserCascade" | "cleanupExpiredSessions"
> {
  return {
    createSession() {
      const n = state.nextId();
      const minted = {
        userId: `user${n}`,
        sessionId: `s${n}`,
        token: `tok${n}`,
        expiresAt: Date.now() + SESSION_TTL_MS,
      };
      return Effect.sync(() => {
        state.users.set(minted.userId, { kind: "anonymous" });
        state.authSessions.set(minted.sessionId, {
          userId: minted.userId,
          expiresAt: minted.expiresAt,
        });
        state.tokens.set(minted.token, minted.userId);
        return { ...minted };
      });
    },
    resolveUserId(token) {
      return Effect.sync(() => state.tokens.get(token) ?? null);
    },
    deleteUserCascade(userId) {
      // A no-op on a user that is already gone: the adapter's postcondition
      // (every count zero) passes on an empty subtree exactly as this does.
      return Effect.sync(() => eraseSubtree(state, userId));
    },
    cleanupExpiredSessions(before = new Date()) {
      return Effect.sync(() => {
        const cutoff = before.getTime();
        for (const [id, session] of [...state.authSessions]) {
          if (session.expiresAt <= cutoff) state.authSessions.delete(id);
        }
        let reclaimed = 0;
        for (const [id, user] of [...state.users]) {
          if (user.kind !== "anonymous") continue;
          const stillHasSession = [...state.authSessions.values()].some((s) => s.userId === id);
          if (stillHasSession) continue;
          eraseSubtree(state, id);
          reclaimed += 1;
        }
        return reclaimed;
      });
    },
  };
}
