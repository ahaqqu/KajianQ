import * as v from "valibot";
import { TraceSchema } from "@app/contracts";
import type {
  DocChildInsert,
  RagStore,
  SimilarChild,
} from "./rag-store";
import {
  buildSimilarityQuery,
  hashToken,
  randomToken,
  rowToChild,
  toVectorLiteral,
  type ChildRow,
} from "./rag-store-shared";

/**
 * The Neon serverless driver's query surface, loosely typed.
 *
 * The adapter only awaits results and validates row shapes itself, so the
 * runner type is intentionally `unknown[]`-shaped rather than generic: this
 * avoids fighting the driver's heavy generics while still letting the real
 * `neon(url)` handle be passed directly, and keeps the adapter unit-testable
 * against a fake that returns canned rows.
 */
export type SqlRunner = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  query(text: string, params?: unknown[]): Promise<unknown[]>;
};

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, per ADR-0017.

/**
 * Create a RagStore backed by Neon Postgres + pgvector. `sql` is the driver's
 * query object, injected so configuration stays in the caller. All SQL in the
 * repository lives in this file and the migrations.
 */
export function createNeonRagStore(sql: SqlRunner): RagStore {
  return {
    async insertDocParent(input) {
      const id = input.id ?? crypto.randomUUID();
      await sql`
        INSERT INTO doc_parents (id, source_key, title, metadata)
        VALUES (
          ${id}, ${input.sourceKey}, ${input.title},
          ${JSON.stringify(input.metadata ?? {})}::jsonb
        )
      `;
      return id;
    },

    async insertDocChild(input: DocChildInsert) {
      const id = input.id ?? crypto.randomUUID();
      await sql`
        INSERT INTO doc_children (
          id, parent_id, text_raw, text_ar, text_id, citation,
          embedding_ar, embedding_id, ordinal, metadata
        )
        VALUES (
          ${id}, ${input.parentId}, ${input.textRaw}, ${input.textAr},
          ${input.textId},
          ${JSON.stringify(input.citation ?? {})}::jsonb,
          ${input.embeddingAr ? toVectorLiteral(input.embeddingAr) : null},
          ${input.embeddingId ? toVectorLiteral(input.embeddingId) : null},
          ${input.ordinal},
          ${JSON.stringify(input.metadata ?? {})}::jsonb
        )
      `;
      return id;
    },

    async similaritySearch(track, embedding, opts) {
      const filters = Object.entries(opts.filters ?? {});
      const params: unknown[] = [toVectorLiteral(embedding), opts.limit];
      for (const [key, val] of filters) {
        params.push(key, Array.isArray(val) ? val : [val]);
      }
      const query = buildSimilarityQuery(track, filters.length);
      const rows = (await sql.query(query, params)) as (ChildRow & {
        distance: unknown;
        rank_dense: unknown;
      })[];
      return rows.map((r) => ({
        child: rowToChild(r),
        distance: Number(r.distance),
        rankDense: Number(r.rank_dense),
      })) satisfies SimilarChild[];
    },

    async insertAnswerTrace(input) {
      const parsed = v.parse(TraceSchema, input.trace);
      const id = crypto.randomUUID();
      await sql`
        INSERT INTO answer_traces (id, message_id, trace)
        VALUES (${id}, ${input.messageId}, ${JSON.stringify(parsed)}::jsonb)
      `;
      return id;
    },

    async getAnswerTraceByMessage(messageId) {
      const rows = (await sql`
        SELECT trace FROM answer_traces WHERE message_id = ${messageId}
      `) as { trace: unknown }[];
      const [row] = rows;
      if (!row) return null;
      return v.parse(TraceSchema, row.trace);
    },

    async createChatSession(input) {
      const id = crypto.randomUUID();
      await sql`
        INSERT INTO chat_sessions (id, user_id, metadata)
        VALUES (${id}, ${input.userId},
                ${JSON.stringify(input.metadata ?? {})}::jsonb)
      `;
      return id;
    },

    async insertChatMessage(input) {
      const id = crypto.randomUUID();
      await sql`
        INSERT INTO chat_messages (
          id, session_id, role, content, answer_trace_id, metadata
        )
        VALUES (
          ${id}, ${input.sessionId}, ${input.role}, ${input.content},
          ${input.answerTraceId ?? null},
          ${JSON.stringify(input.metadata ?? {})}::jsonb
        )
      `;
      return id;
    },

    async createSession() {
      const userId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const token = randomToken();
      const expiresAt = Date.now() + SESSION_TTL_MS;
      await sql`INSERT INTO users (id, kind) VALUES (${userId}, 'anonymous')`;
      await sql`
        INSERT INTO sessions (id, user_id, token_hash, expires_at)
        VALUES (${sessionId}, ${userId}, ${await hashToken(token)},
                ${new Date(expiresAt).toISOString()})
      `;
      return { userId, sessionId, token, expiresAt };
    },

    async resolveUserId(token) {
      const rows = (await sql`
        SELECT user_id FROM sessions
        WHERE token_hash = ${await hashToken(token)} AND expires_at > now()
        LIMIT 1
      `) as { user_id: string }[];
      const [row] = rows;
      return row ? row.user_id : null;
    },

    async deleteUserCascade(userId) {
      // sessions, chat_sessions/chat_messages, and feedback reference users
      // with ON DELETE CASCADE, so one delete removes the subtree.
      await sql`DELETE FROM users WHERE id = ${userId}`;
    },
  };
}
