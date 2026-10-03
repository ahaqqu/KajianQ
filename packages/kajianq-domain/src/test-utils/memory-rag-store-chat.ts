import { Effect } from "effect";
import { StoreError, type RagStore } from "@app/infra";

/**
 * Chat-session methods of the in-memory RagStore (#10), split from
 * `memory-rag-store.ts` to respect the agentic size limits — same pattern as
 * `memory-rag-store-auth.ts` / `memory-rag-store-eval.ts`. The maps are owned
 * by the main factory and shared here by reference, so the auth cascade
 * (`deleteUserCascade`) can still reclaim chat sessions.
 *
 * The stand-in models the production SHAPE and its FAILURE modes, not just its
 * happy path: `chat_sessions.id` is a Postgres `uuid` column, and an id that
 * column cannot hold is refused by the adapter's cast (SQLSTATE 22P02 →
 * `StoreError` kind "constraint"). A stand-in that quietly returned null there
 * would let a route past the boundary look healthy in tests and only break
 * against the real store — which is how the #271 500 shipped.
 */
export type MemoryChatState = {
  /** Chat session id (`uuid` in production) → owning user id. */
  chatSessions: Map<string, string>;
  chatMessages: Map<
    string,
    {
      sessionId: string;
      role: string;
      content: string;
      answerTraceId: string | null;
    }
  >;
};

/**
 * Can the `chat_sessions.id` (uuid) column hold this value? Approximates the
 * column's grammar: LOOSE where PostgreSQL is loose — braces, a hyphen-less
 * 32-hex form, and uppercase are all admitted — but decisive about the failure
 * #271 is about: a short non-hex value such as `en` or `sess1` is not a uuid
 * and cannot be cast. `urn:uuid:…` is NOT one of the accepted forms: a live
 * read-only check against the real column on staging (PostgreSQL 17.11,
 * QA #289) rejected it, and the stand-in refuses it too. Where the stand-in is
 * TIGHTER than the column: PostgreSQL accepts an extra hyphen after a group of
 * four digits (QA #289's `7b1a-712f-…` named the existing row) and this
 * predicate refuses it — inert, because `ChatSessionIdSchema` refuses that
 * spelling before the store.
 *
 * Its looseness is a superset of what `ChatSessionIdSchema` admits (the
 * canonical hyphenated 8-4-4-4-12 shape, either case), which makes that
 * schema's narrowing UNREACHABLE rather than merely untested — see
 * `ChatSessionIdSchema` for the rationale.
 */
function uuidShaped(value: string): boolean {
  return /^[{]?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}[}]?$/i.test(value);
}

export function memoryChatMethods(
  state: MemoryChatState,
): Pick<
  RagStore,
  "createChatSession" | "getChatSessionUser" | "insertChatMessage" | "getChatMessages"
> {
  return {
    createChatSession(input) {
      return Effect.sync(() => {
        // A uuid, like the real `chat_sessions.id` (minted by the Postgres
        // adapter with crypto.randomUUID): the API's request contracts address
        // a chat session as a UUID (#271 — both the `sessionId` body member and
        // the rehydration path param), so the stand-in must agree with the
        // production shape or route tests would exercise an id the real store
        // can never mint.
        const id = crypto.randomUUID();
        state.chatSessions.set(id, input.userId);
        return id;
      });
    },
    // A6: ownership validation for client-supplied session ids.
    getChatSessionUser(sessionId) {
      if (!uuidShaped(sessionId)) {
        return Effect.fail(
          new StoreError({
            kind: "constraint",
            cause: new Error(`invalid input syntax for type uuid: "${sessionId}"`),
          }),
        );
      }
      return Effect.succeed(state.chatSessions.get(sessionId) ?? null);
    },
    insertChatMessage(input) {
      return Effect.sync(() => {
        // A uuid, like the real `chat_messages.id` DEFAULT gen_random_uuid():
        // the feedback route's contract admits only uuid message ids, and a
        // rehydrated surface addresses answers by THIS id (thermo-review A2's
        // test path) — the stand-in must agree with the production shape.
        const id = crypto.randomUUID();
        state.chatMessages.set(id, {
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
        const all = [...state.chatMessages.entries()].map(([id, m], i) => ({
          id,
          sessionId: m.sessionId,
          role: m.role,
          content: m.content,
          answerTraceId: m.answerTraceId,
          createdAt: i,
        }));
        return all.filter((m) => m.sessionId === sessionId).slice(-limit);
      });
    },
  };
}
