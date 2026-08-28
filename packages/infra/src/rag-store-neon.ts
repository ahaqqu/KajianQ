import type {
  DocChildInsert,
  RagStore,
  SimilarChild,
} from "./rag-store";
import {
  assertEmbedding,
  CORPUS_EMBEDDING_DIM,
  hashToken,
  parseTrace,
  randomToken,
  rowToChild,
  toVectorLiteral,
  toVectorLiteralChecked,
  type ChildRow,
} from "./rag-store-shared";
import { buildSimilarityQuery } from "./rag-store-neon-query";
import {
  DEFAULT_SLOW_QUERY_MS,
  instrumentRunner,
  type NeonRagStoreOptions,
} from "./rag-store-neon-logging";

/**
 * The Neon serverless driver's query surface, loosely typed.
 *
 * The adapter only awaits results and validates row shapes itself, so the
 * runner type is intentionally `unknown[]`-shaped rather than generic: this
 * avoids fighting the driver's heavy generics while still letting the real
 * driver query handle be passed directly, and keeps the adapter
 * unit-testable against a fake that returns canned rows. `transaction`
 * mirrors the Neon HTTP driver's non-interactive transaction primitive, used
 * so multi-statement writes (e.g. createSession) are atomic.
 */
export type SqlRunner = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  query(text: string, params?: unknown[]): Promise<unknown[]>;
  // `any` here is deliberate: the Neon HTTP driver's `transaction()` accepts
  // a union of an array of its own query-promise type OR a callback, and the
  // adapter only ever passes an array of the call-signature's `Promise<unknown[]>`.
  // A precise signature would force callers into a cast; `any` keeps the
  // already-loose runner assignable from the real driver handle.
  transaction(queries: any[]): Promise<any>;
};

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, per ADR-0017.

/**
 * Create a RagStore backed by Neon Postgres + pgvector. `sql` is the driver's
 * query object, injected so configuration stays in the caller. All executable
 * SQL in the repository lives in this file (and `rag-store-neon-query.ts`)
 * and the migrations. Pass `opts.logger` to get slow-query/error ops logging
 * (`rag-store-neon-logging.ts`); omitted, the adapter stays silent.
 */
export function createNeonRagStore(
  rawSql: SqlRunner,
  opts: NeonRagStoreOptions = {},
): RagStore {
  const logger = opts.logger ?? null;
  const slowQueryMs = opts.slowQueryMs ?? DEFAULT_SLOW_QUERY_MS;
  const sql =
    logger === null ? rawSql : instrumentRunner(rawSql, logger, slowQueryMs);
  return {
    async insertDocParent(input) {
      const id = input.id ?? crypto.randomUUID();
      // Idempotent upsert by provenance key (AGENTS.md rule 13): re-running
      // ingestion with the same source_key updates metadata/title in place
      // and returns the existing id, never duplicates.
      const rows = (await sql`
        INSERT INTO doc_parents (id, source_key, title, metadata)
        VALUES (
          ${id}, ${input.sourceKey}, ${input.title},
          ${JSON.stringify(input.metadata ?? {})}::jsonb
        )
        ON CONFLICT (source_key) DO UPDATE
          SET title = EXCLUDED.title, metadata = EXCLUDED.metadata
        RETURNING id
      `) as { id: string }[];
      return rows[0]?.id ?? id;
    },

    async insertDocChild(input: DocChildInsert) {
      const id = input.id ?? crypto.randomUUID();
      const embeddingPrimary = toVectorLiteralChecked(
        input.embeddingPrimary,
        CORPUS_EMBEDDING_DIM,
      );
      const embeddingFallback = toVectorLiteralChecked(
        input.embeddingFallback,
        CORPUS_EMBEDDING_DIM,
      );
      // Idempotent upsert by (parent_id, ordinal). text_raw is immutable
      // (AGENTS.md rule 13): it is NOT in the UPDATE set — only the derived
      // layers (translations, embeddings, citation, metadata) refresh.
      // Column names are role-based (`embedding_primary`/`embedding_fallback`);
      // KajianQ binds the roles to its AR/ID language tracks at the
      // domain-pack boundary.
      const rows = (await sql`
        INSERT INTO doc_children (
          id, parent_id, text_raw, text_ar, text_id, citation,
          embedding_primary, embedding_fallback, ordinal, metadata
        )
        VALUES (
          ${id}, ${input.parentId}, ${input.textRaw}, ${input.textAr},
          ${input.textId},
          ${JSON.stringify(input.citation ?? {})}::jsonb,
          ${embeddingPrimary},
          ${embeddingFallback},
          ${input.ordinal},
          ${JSON.stringify(input.metadata ?? {})}::jsonb
        )
        ON CONFLICT (parent_id, ordinal) DO UPDATE
          SET text_ar = EXCLUDED.text_ar,
              text_id = EXCLUDED.text_id,
              citation = EXCLUDED.citation,
              embedding_primary = EXCLUDED.embedding_primary,
              embedding_fallback = EXCLUDED.embedding_fallback,
              metadata = EXCLUDED.metadata
        RETURNING id
      `) as { id: string }[];
      return rows[0]?.id ?? id;
    },

    async similaritySearch(track, embedding, opts) {
      assertEmbedding(embedding, CORPUS_EMBEDDING_DIM);
      const filters = Object.entries(opts.filters ?? {});
      // $1 embedding, $2 limit, then per filter: the key string ($k) and the
      // values array ($v) — both bound, matching buildSimilarityQuery's slots.
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
      const parsed = parseTrace(input.trace);
      const id = crypto.randomUUID();
      await sql`
        INSERT INTO answer_traces (id, message_id, user_id, trace)
        VALUES (
          ${id}, ${input.messageId}, ${input.userId},
          ${JSON.stringify(parsed)}::jsonb
        )
      `;
      return id;
    },

    async getAnswerTraceByMessage(messageId) {
      const rows = (await sql`
        SELECT trace FROM answer_traces WHERE message_id = ${messageId}
      `) as { trace: unknown }[];
      const [row] = rows;
      if (!row) return null;
      // Tolerant reader (ADR-0007 amendment): the Trace contract only ever
      // ADDS optional fields (versioned), so parseTrace accepts older traces and
      // strips unknown future keys rather than throwing. Never add a required
      // field to TraceSchema without a migration of persisted traces.
      return parseTrace(row.trace);
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
      const tokenHash = await hashToken(token);
      // Atomic: the user row and its session row are written in one Neon HTTP
      // non-interactive transaction, so a mid-write failure cannot orphan a
      // user with no session.
      await sql.transaction([
        sql`INSERT INTO users (id, kind) VALUES (${userId}, 'anonymous')`,
        sql`
          INSERT INTO sessions (id, user_id, token_hash, expires_at)
          VALUES (${sessionId}, ${userId}, ${tokenHash},
                  ${new Date(expiresAt).toISOString()})
        `,
      ]);
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

    async cleanupExpiredSessions(before = new Date()) {
      const rows = (await sql`
        DELETE FROM sessions WHERE expires_at <= ${before.toISOString()}
        RETURNING id
      `) as { id: string }[];
      return rows.length;
    },

    async deleteUserCascade(userId) {
      // sessions, chat_sessions/chat_messages, feedback, and answer_traces
      // all reference users with ON DELETE CASCADE (answer_traces via its
      // user_id FK, ADR-0007 amendment), so one delete removes the full
      // subtree — including the user's Q&A traces.
      await sql`DELETE FROM users WHERE id = ${userId}`;
    },
  };
}