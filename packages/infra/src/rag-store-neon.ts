import { Effect } from "effect";
import type { Trace } from "@app/contracts";
import type { StoreError } from "@app/rag-core";
import type { AlignedPairInsert, DocChildInsert, RagStore, SimilarChild } from "./rag-store";
import {
  checkEmbedding,
  constraintError,
  CORPUS_EMBEDDING_DIM,
  hashToken,
  parseTrace,
  randomToken,
  rowToChildEffect,
  toVectorLiteral,
  type ChildRow,
} from "./rag-store-shared";

import { buildSimilarityQuery } from "./rag-store-neon-query";
import { buildBatchChildUpsert } from "./rag-store-neon-batch";
import { neonErrorToStoreError, sqlEffect } from "./rag-store-neon-errors";
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
 * Create a RagStore backed by Neon Postgres + pgvector (ADR-0027 decision 7:
 * the seam is Effect-signatured — every method returns
 * `Effect<A, StoreError>`; driver failures are classified inside the
 * adapter). `sql` is the driver's query object, injected so configuration
 * stays in the caller. All executable SQL in the repository lives in this
 * file (and `rag-store-neon-query.ts`) and the migrations. Pass
 * `opts.logger` to get slow-query/error ops logging
 * (`rag-store-neon-logging.ts`); omitted, the adapter stays silent.
 */
export function createNeonRagStore(rawSql: SqlRunner, opts: NeonRagStoreOptions = {}): RagStore {
  const logger = opts.logger ?? null;
  const slowQueryMs = opts.slowQueryMs ?? DEFAULT_SLOW_QUERY_MS;
  const sql = logger === null ? rawSql : instrumentRunner(rawSql, logger, slowQueryMs);
  return {
    insertDocParent(input) {
      const id = input.id ?? crypto.randomUUID();
      // Idempotent upsert by provenance key (AGENTS.md rule 13): re-running
      // ingestion with the same source_key updates metadata/title in place
      // and returns the existing id, never duplicates.
      const run = () =>
        sql`
          INSERT INTO doc_parents (id, source_key, title, metadata)
          VALUES (
            ${id}, ${input.sourceKey}, ${input.title},
            ${JSON.stringify(input.metadata ?? {})}::jsonb
          )
          ON CONFLICT (source_key) DO UPDATE
            SET title = EXCLUDED.title, metadata = EXCLUDED.metadata
          RETURNING id
        ` as Promise<{ id: string }[]>;
      return Effect.map(
        sqlEffect(sql, run),
        (rows) => rows[0]?.id ?? id,
      );
    },

    insertDocChild(input: DocChildInsert) {
      return Effect.map(this.insertDocChildren([input]), (ids) => ids[0] ?? crypto.randomUUID());
    },

    insertDocChildren(batch: readonly DocChildInsert[]) {
      if (batch.length === 0) return Effect.succeed([] as readonly string[]);
      return Effect.flatMap(buildBatchChildUpsert(batch), ({ text, values, rowIds }) =>
        Effect.map(
          sqlEffect(sql, () => sql.query(text, values) as Promise<{ id: string }[]>),
          (rows) =>
            // The single-row path falls back to the generated id when RETURNING is
            // empty, preserving insertDocChild's upsert semantics.
            rows.map((r, i) => r.id ?? rowIds[i] ?? crypto.randomUUID()),
        ),
      );
    },

    upsertAlignedPair(input: AlignedPairInsert) {
      const id = crypto.randomUUID();
      // Idempotent upsert by provenance key (AGENTS.md rule 11): re-running
      // ingestion with the same pair_key refreshes the tracks, citation, and
      // morphology in place and returns the existing id, never duplicates.
      // Column names are role-based (`text_primary`/`text_secondary`); the
      // domain pack binds the roles to its language tracks at its boundary.
      return Effect.map(
        sqlEffect(sql, () => sql`
          INSERT INTO aligned_pairs (id, pair_key, citation, text_primary, text_secondary, morphology)
          VALUES (
            ${id}, ${input.pairKey},
            ${JSON.stringify(input.citation)}::jsonb,
            ${input.textPrimary},
            ${input.textSecondary},
            ${JSON.stringify(input.morphology ?? [])}::jsonb
          )
          ON CONFLICT (pair_key) DO UPDATE
            SET citation = EXCLUDED.citation,
                text_primary = EXCLUDED.text_primary,
                text_secondary = EXCLUDED.text_secondary,
                morphology = EXCLUDED.morphology,
                updated_at = now()
          RETURNING id
        ` as Promise<{ id: string }[]>),
        (rows) => rows[0]?.id ?? id,
      );
    },

    similaritySearch(track, embedding, opts) {
      // Validate before touching the DB: a misconfigured provider or
      // ingestion bug fails loudly at the seam as a `constraint` StoreError
      // instead of an opaque pgvector dimension error.
      return Effect.flatMap(
        Effect.flatMap(
          checkEmbedding(embedding, CORPUS_EMBEDDING_DIM),
          (vec) => Effect.succeed({ vec, literal: toVectorLiteral(embedding) }),
        ),
        ({ literal }) => {
          const filters = Object.entries(opts.filters ?? {});
          // $1 embedding, $2 limit, then per filter: the key string ($k) and the
          // values array ($v) — both bound, matching buildSimilarityQuery's slots.
          const params: unknown[] = [literal, opts.limit];
          for (const [key, val] of filters) {
            params.push(key, Array.isArray(val) ? val : [val]);
          }
          const query = buildSimilarityQuery(track, filters.length);
          return Effect.flatMap(
            sqlEffect(
              sql,
              () =>
                sql.query(query, params) as Promise<
                  (ChildRow & { distance: unknown; rank_dense: unknown })[]
                >,
            ),
            (rows) =>
              Effect.map(
                Effect.forEach(rows, (r) =>
                  Effect.map(rowToChildEffect(r), (child) => ({
                    child,
                    distance: Number(r.distance),
                    rankDense: Number(r.rank_dense),
                  })),
                ),
                (hits) => hits satisfies SimilarChild[],
              ),
          );
        },
      );
    },

    insertAnswerTrace(input) {
      // Trace contract violations are constraint-class: the input, not the
      // store, is bad — deterministic, never retried into place.
      const parsed = Effect.try({
        try: () => parseTrace(input.trace),
        catch: constraintError,
      });
      const id = crypto.randomUUID();
      return Effect.flatMap(parsed, (trace) =>
        Effect.as(
          sqlEffect(sql, () => sql`
            INSERT INTO answer_traces (id, message_id, user_id, trace)
            VALUES (
              ${id}, ${input.messageId}, ${input.userId},
              ${JSON.stringify(trace)}::jsonb
            )
          ` as Promise<unknown[]>),
          id,
        ),
      );
    },

    getAnswerTraceByMessage(messageId) {
      return Effect.flatMap(
        sqlEffect(sql, () => sql`
          SELECT trace FROM answer_traces WHERE message_id = ${messageId}
        ` as Promise<{ trace: unknown }[]>),
        (rows) => {
          const [row] = rows;
          if (!row) return Effect.succeed<Trace | null>(null);
          // Tolerant reader (ADR-0007 amendment): the Trace contract only ever
          // ADDS optional fields (versioned), so parseTrace accepts older traces and
          // strips unknown future keys rather than failing. Never add a required
          // field to TraceSchema without a migration of persisted traces.
          // A corrupt persisted trace is constraint-class (schema drift),
          // surfaced — never silently coerced.
          // A corrupt persisted trace is constraint-class (schema drift),
          // surfaced — never silently coerced.
          return Effect.mapError(
            Effect.try({
              try: () => parseTrace(row.trace) as Trace | null,
              catch: constraintError,
            }),
            (e) => e,
          );
        },
      );
    },

    createChatSession(input) {
      const id = crypto.randomUUID();
      return Effect.as(
        sqlEffect(sql, () => sql`
          INSERT INTO chat_sessions (id, user_id, metadata)
          VALUES (${id}, ${input.userId},
                  ${JSON.stringify(input.metadata ?? {})}::jsonb)
        ` as Promise<unknown[]>),
        id,
      );
    },

    insertChatMessage(input) {
      const id = crypto.randomUUID();
      return Effect.as(
        sqlEffect(sql, () => sql`
          INSERT INTO chat_messages (
            id, session_id, role, content, answer_trace_id, metadata
          )
          VALUES (
            ${id}, ${input.sessionId}, ${input.role}, ${input.content},
            ${input.answerTraceId ?? null},
            ${JSON.stringify(input.metadata ?? {})}::jsonb
          )
        ` as Promise<unknown[]>),
        id,
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
            sqlEffect(sql, () => sql`
              SELECT user_id FROM sessions
              WHERE token_hash = ${tokenHash} AND expires_at > now()
              LIMIT 1
            ` as Promise<{ user_id: string }[]>),
            (rows) => rows[0]?.user_id ?? null,
          ),
      );
    },

    cleanupExpiredSessions(before = new Date()) {
      return Effect.map(
        sqlEffect(sql, () => sql`
          DELETE FROM sessions WHERE expires_at <= ${before.toISOString()}
          RETURNING id
        ` as Promise<{ id: string }[]>),
        (rows) => rows.length,
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

    insertEvalRun(input) {
      const id = input.id ?? crypto.randomUUID();
      // Idempotent by run id: re-running the same ingestion run refreshes the
      // label and report so the ledger stays the single source of truth.
      return Effect.map(
        sqlEffect(sql, () => sql`
          INSERT INTO eval_runs (id, label, report)
          VALUES (
            ${id}, ${input.label ?? null},
            ${JSON.stringify(input.report)}::jsonb
          )
          ON CONFLICT (id) DO UPDATE
            SET label = EXCLUDED.label,
                report = EXCLUDED.report,
                created_at = now()
          RETURNING id
        ` as Promise<{ id: string }[]>),
        (rows) => rows[0]?.id ?? id,
      );
    },
  };
}