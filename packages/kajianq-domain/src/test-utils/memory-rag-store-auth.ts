import { Effect } from "effect";
import type { RagStore } from "@app/infra";

/**
 * Anonymous-session methods of the in-memory RagStore (ADR-0017), split from
 * `memory-rag-store.ts` to respect the agentic size limits — same pattern as
 * `memory-rag-store-eval.ts` / `memory-rag-store-feedback.ts`. The maps are
 * owned by the main factory and shared here by reference. Cleanup and cascade
 * semantics mirror the Neon adapter's contract (thermo-review A5): expired
 * sessions AND the anonymous users left with no session, one call, reclaimed
 * user count returned; the cascade removes the user's full subtree.
 */
export type MemoryAuthState = {
  users: Map<string, { kind: string }>;
  authSessions: Map<string, { userId: string; expiresAt: number }>;
  /** Hash-standin token → userId. */
  tokens: Map<string, string>;
  chatSessions: Map<string, string>;
  /** Traces by message id, plus their owners (ADR-0007 amendment). */
  traces: Map<string, unknown>;
  traceOwners: Map<string, string | null>;
  feedback: Map<string, { userId: string }>;
  nextId: () => number;
};

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
      return Effect.sync(() => {
        state.users.delete(userId);
        for (const [id, owner] of [...state.chatSessions]) {
          if (owner === userId) state.chatSessions.delete(id);
        }
        for (const [id, session] of [...state.authSessions]) {
          if (session.userId === userId) state.authSessions.delete(id);
        }
        for (const [messageId, owner] of [...state.traceOwners]) {
          if (owner === userId) {
            state.traces.delete(messageId);
            state.traceOwners.delete(messageId);
          }
        }
        for (const [id, row] of [...state.feedback]) {
          if (row.userId === userId) state.feedback.delete(id);
        }
      });
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
          if (!stillHasSession) {
            state.users.delete(id);
            for (const [chatId, owner] of [...state.chatSessions]) {
              if (owner === id) state.chatSessions.delete(chatId);
            }
            reclaimed += 1;
          }
        }
        return reclaimed;
      });
    },
  };
}
