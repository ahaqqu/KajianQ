import { Effect } from "effect";
import { StoreError, type RagStore } from "@app/infra";
import { canonicalUuid } from "./memory-rag-store-uuid";

/**
 * Chat-session methods of the in-memory RagStore, sharing the main factory's
 * maps by reference so the auth cascade (`deleteUserCascade`) can reclaim chat
 * sessions.
 *
 * The stand-in models the production SHAPE and its FAILURE modes: an id the
 * `chat_sessions.id` uuid column cannot hold is refused with `StoreError` kind
 * "constraint" (SQLSTATE 22P02), never reported as absent. An id it CAN hold is
 * compared the way the column compares it — case-insensitively — so any
 * schema-admitted spelling of one id reaches that id's row (`canonicalUuid`).
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
 * column's grammar: loose where PostgreSQL is loose (braces, hyphen-less
 * 32-hex, uppercase), decisive about a short non-hex value such as `en` or
 * `sess1`, which cannot be cast; `urn:uuid:…` is not accepted. It is TIGHTER
 * than the column on one point — PostgreSQL accepts an extra hyphen after four
 * digits — which is inert, because `ChatSessionIdSchema` refuses that spelling.
 *
 * The gate decides CASTABILITY, not which row an admitted id names: the maps
 * canonicalise case, so the uppercase and mixed-case spellings the gate admits
 * address the row the canonical spelling seeded, exactly as the column's cast
 * does. The gate's other loose forms (braces, hyphen-less) are never admitted
 * by a request schema, so no row can be asked for under them.
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
        // A uuid, like the real `chat_sessions.id`: request contracts address a
        // chat session as a UUID, and route tests would otherwise exercise an
        // id the real store can never mint. The key is the column's canonical
        // text — minting already yields it, and forming it at the map boundary
        // keeps a re-cased lookup from missing the row.
        const id = crypto.randomUUID();
        state.chatSessions.set(canonicalUuid(id), input.userId);
        return id;
      });
    },
    // Ownership validation for client-supplied session ids.
    getChatSessionUser(sessionId) {
      if (!uuidShaped(sessionId)) {
        return Effect.fail(
          new StoreError({
            kind: "constraint",
            cause: new Error(`invalid input syntax for type uuid: "${sessionId}"`),
          }),
        );
      }
      return Effect.succeed(state.chatSessions.get(canonicalUuid(sessionId)) ?? null);
    },
    insertChatMessage(input) {
      return Effect.sync(() => {
        // A uuid, like the real `chat_messages.id`: only uuid message ids pass
        // the feedback route's contract, and answers are addressed by this id.
        const id = crypto.randomUUID();
        state.chatMessages.set(canonicalUuid(id), {
          // `session_id` is a uuid column: it holds the canonical text form, not
          // the spelling the request carried, so either spelling reads it back.
          sessionId: canonicalUuid(input.sessionId),
          role: input.role,
          content: input.content,
          answerTraceId: input.answerTraceId ?? null,
        });
        return id;
      });
    },
    // The session's tail, oldest first — insertion order stands in for
    // `created_at` (the memory store has no clock).
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
        const wanted = canonicalUuid(sessionId);
        return all.filter((m) => m.sessionId === wanted).slice(-limit);
      });
    },
  };
}
