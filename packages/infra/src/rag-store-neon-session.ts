import { Effect } from "effect";
import type { RagStore } from "./rag-store";
import { hashToken, randomToken } from "./rag-store-shared";
import { neonErrorToStoreError, sqlEffect, type SqlRunner } from "./rag-store-neon-errors";

/**
 * Session/auth/chat methods of the Neon RagStore adapter, split from
 * `rag-store-neon.ts` to respect the agentic size limits (ADR-0027 decision
 * 7 migration kept all executable SQL inside the Neon adapter surface: this
 * file, `rag-store-neon.ts`, `rag-store-neon-query.ts`, and the migrations).
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, per ADR-0017.

/** The session/auth/chat half of the `RagStore` interface, Neon-backed. */
export function neonSessionMethods(
  sql: SqlRunner,
): Pick<
  RagStore,
  | "createChatSession"
  | "getChatSessionUser"
  | "insertChatMessage"
  | "getChatMessages"
  | "createSession"
  | "resolveUserId"
  | "deleteUserCascade"
  | "cleanupExpiredSessions"
> {
  return {
    createChatSession(input) {
      const id = crypto.randomUUID();
      return Effect.as(
        sqlEffect(
          sql,
          () =>
            sql`
          INSERT INTO chat_sessions (id, user_id, metadata)
          VALUES (${id}, ${input.userId},
                  ${JSON.stringify(input.metadata ?? {})}::jsonb)
        ` as Promise<unknown[]>,
        ),
        id,
      );
    },

    // A6: ownership validation for client-supplied session ids.
    getChatSessionUser(sessionId) {
      return Effect.map(
        sqlEffect(
          sql,
          () =>
            sql`
          SELECT user_id FROM chat_sessions WHERE id = ${sessionId}::uuid
        ` as Promise<{ user_id: string | null }[]>,
        ),
        (rows) => rows[0]?.user_id ?? null,
      );
    },

    insertChatMessage(input) {
      const id = crypto.randomUUID();
      return Effect.as(
        sqlEffect(
          sql,
          () =>
            sql`
          INSERT INTO chat_messages (
            id, session_id, role, content, answer_trace_id, metadata
          )
          VALUES (
            ${id}, ${input.sessionId}, ${input.role}, ${input.content},
            ${input.answerTraceId ?? null},
            ${JSON.stringify(input.metadata ?? {})}::jsonb
          )
        ` as Promise<unknown[]>,
        ),
        id,
      );
    },

    // Follow-up context (#10): the most recent `limit` messages of a session,
    // returned in chronological order. The inner DESC + outer ASC takes a
    // tail off the `(session_id, created_at)` index without sorting the whole
    // session.
    getChatMessages(sessionId, opts) {
      const limit = opts?.limit ?? 20;
      return Effect.map(
        sqlEffect(
          sql,
          () =>
            sql`
          SELECT id, session_id, role, content, answer_trace_id, created_at
          FROM (
            SELECT id, session_id, role, content, answer_trace_id, created_at
            FROM chat_messages
            WHERE session_id = ${sessionId}::uuid
            ORDER BY created_at DESC
            LIMIT ${limit}
          ) AS tail
          ORDER BY created_at ASC
        ` as Promise<
              {
                id: string;
                session_id: string;
                role: string;
                content: string;
                answer_trace_id: string | null;
                created_at: string | Date;
              }[]
            >,
        ),
        (rows) =>
          rows.map((row) => ({
            id: row.id,
            sessionId: row.session_id,
            role: row.role,
            content: row.content,
            answerTraceId: row.answer_trace_id,
            createdAt: new Date(row.created_at).getTime(),
          })),
      );
    },

    createSession() {
      const userId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const token = randomToken();
      const expiresAt = Date.now() + SESSION_TTL_MS;
      // Atomic: the user row and its session row are written in one Neon HTTP
      // non-interactive transaction, so a mid-write failure cannot orphan a
      // user with no session.
      return Effect.flatMap(
        Effect.tryPromise({
          try: () => hashToken(token),
          catch: neonErrorToStoreError,
        }),
        (tokenHash) =>
          Effect.as(
            sqlEffect(sql, () =>
              sql.transaction([
                sql`INSERT INTO users (id, kind) VALUES (${userId}, 'anonymous')`,
                sql`
                  INSERT INTO sessions (id, user_id, token_hash, expires_at)
                  VALUES (${sessionId}, ${userId}, ${tokenHash},
                          ${new Date(expiresAt).toISOString()})
                `,
              ]),
            ),
            { userId, sessionId, token, expiresAt },
          ),
      );
    },

    resolveUserId(token) {
      return Effect.flatMap(
        Effect.tryPromise({
          try: () => hashToken(token),
          catch: neonErrorToStoreError,
        }),
        (tokenHash) =>
          Effect.map(
            sqlEffect(
              sql,
              () =>
                sql`
              SELECT user_id FROM sessions
              WHERE token_hash = ${tokenHash} AND expires_at > now()
              LIMIT 1
            ` as Promise<{ user_id: string }[]>,
            ),
            (rows) => rows[0]?.user_id ?? null,
          ),
      );
    },

    cleanupExpiredSessions(before = new Date()) {
      // Two statements, one call (thermo-review A5): the expired token rows,
      // and the anonymous users left with no session at all. The FK cascade
      // runs user → session, never the reverse, so without the second DELETE
      // every abandoned browser leaves a permanent `users` row plus its
      // `chat_sessions`/`chat_messages`/`answer_traces` subtree — the exact
      // unbounded growth this cleanup exists to prevent. Both run in one Neon
      // transaction so a crash between them cannot strand a half-reclaimed
      // user, and the returned count is the reclaimed users (the number the
      // cron reports as storage reclaimed).
      return Effect.map(
        sqlEffect(sql, () =>
          sql.transaction([
            sql`
              DELETE FROM sessions WHERE expires_at <= ${before.toISOString()}
            `,
            sql`
              DELETE FROM users
              WHERE kind = 'anonymous'
                AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.user_id = users.id)
              RETURNING id
            `,
          ]),
        ),
        (results) => {
          // Neon's transaction() resolves one result per statement, in order;
          // the user-reclamation statement is the second. A driver that
          // resolves differently is a contract violation, not a count to
          // guess at — report 0 rather than a wrong number.
          const users = Array.isArray(results) ? results[1] : undefined;
          return Array.isArray(users) ? users.length : 0;
        },
      );
    },

    deleteUserCascade(userId) {
      // sessions, chat_sessions/chat_messages, feedback, and answer_traces
      // all reference users with ON DELETE CASCADE (answer_traces via its
      // user_id FK, ADR-0007 amendment), so one delete removes the full
      // subtree — including the user's Q&A traces.
      return Effect.as(
        sqlEffect(sql, () => sql`DELETE FROM users WHERE id = ${userId}` as Promise<unknown[]>),
        void 0,
      );
    },
  };
}
