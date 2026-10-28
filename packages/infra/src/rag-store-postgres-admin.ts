import { Effect } from "effect";
import {
  ADMIN_ACCESS_LOG_RETENTION_DAYS,
  type AdminAccessEntry,
  type AdminSessionRevocation,
  type AdminTraceFilter,
  type AdminTracePage,
  type AdminTraceRawRecord,
  type AdminTraceRecord,
  type RagStoreAdmin,
} from "./rag-store-admin-seam";
import {
  CREATED_AT_MS,
  num,
  ROW_COLUMNS,
  ROW_FROM,
  toRow,
  type Row,
} from "./rag-store-postgres-admin-row";
import { sqlEffect, type SqlRunner } from "./rag-store-postgres-errors";
import { constraintError, parseTrace } from "./rag-store-shared";

/**
 * The admin Trace browser's Postgres methods (ADR-0064). Every value a filter
 * carries is a bound parameter — the WHERE clause is assembled from `$n`
 * placeholders, never from the caller's text — and the list is paginated by the
 * store (`LIMIT`/`OFFSET`), so a filter cannot be widened or an unbounded read
 * started from the query string.
 *
 * The one join that carries content is `chat_messages`: the question is the
 * session's most recent user row at or before the answer, and the answer is the
 * row the trace's `message_id` names. A trace is never parsed to reconstruct
 * either — the JSONB reads below only project the trace-derived FACTS the browser
 * searches on (intent, models, refusal, relaxation) and the per-message totals.
 */

/** The filter as `$n`-placeholder predicates plus the parameters they bind. */
function whereOf(filter: AdminTraceFilter): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const parts: string[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filter.text !== undefined) {
    // A substring match on the transcript's own text, both sides lowered: `strpos`
    // keeps `%` and `_` literal, so a search never silently becomes a wildcard.
    const needle = bind(filter.text.toLowerCase());
    parts.push(
      `(strpos(lower(uq.content), ${needle}) > 0 OR strpos(lower(m.content), ${needle}) > 0)`,
    );
  }
  if (filter.from !== undefined) {
    parts.push(`${CREATED_AT_MS} >= ${bind(filter.from)}`);
  }
  if (filter.to !== undefined) {
    parts.push(`${CREATED_AT_MS} <= ${bind(filter.to)}`);
  }
  if (filter.intent !== undefined) {
    parts.push(`EXISTS (
      SELECT 1 FROM jsonb_array_elements(t.trace->'events') AS ev(e)
      WHERE e->>'kind' = 'intent' AND e->'detail'->>'intent' = ${bind(filter.intent)}
    )`);
  }
  if (filter.model !== undefined) {
    parts.push(`EXISTS (
      SELECT 1 FROM jsonb_array_elements(t.trace->'events') AS ev(e)
      WHERE e->'cost'->>'modelId' = ${bind(filter.model)}
    )`);
  }
  if (filter.refused !== undefined) {
    parts.push(`${filter.refused ? "" : "NOT "}EXISTS (
      SELECT 1 FROM jsonb_array_elements(t.trace->'events') AS ev(e)
      WHERE e->>'kind' = 'refusal'
    )`);
  }
  if (filter.filterRelaxed !== undefined) {
    // The same reading `deriveTraceFrame` takes: a probe that adopted nothing is
    // machinery, not a relaxation, so it is not a row this filter selects.
    parts.push(`${filter.filterRelaxed ? "" : "NOT "}EXISTS (
      SELECT 1 FROM jsonb_array_elements(t.trace->'events') AS ev(e)
      WHERE e->>'kind' = 'filter_relaxed'
        AND COALESCE(e->'detail'->>'adopted', 'true') <> 'false'
    )`);
  }
  if (filter.minLatencyMs !== undefined) {
    parts.push(`COALESCE(tot.latency_ms, 0) >= ${bind(filter.minLatencyMs)}`);
  }
  if (filter.minCostMicroUsd !== undefined) {
    parts.push(`COALESCE(tot.cost_micro_usd, 0) >= ${bind(filter.minCostMicroUsd)}`);
  }
  return { text: parts.length === 0 ? "" : ` AND ${parts.join(" AND ")}`, params };
}

export function postgresAdminMethods(
  sql: SqlRunner,
): Pick<
  RagStoreAdmin,
  | "recordAdminAccess"
  | "listAdminTraces"
  | "getAdminTrace"
  | "getAdminTraceRaw"
  | "purgeAdminAccessLog"
  | "revokeAdminSession"
  | "isAdminSessionRevoked"
  | "purgeAdminSessionRevocations"
> {
  return {
    recordAdminAccess(entry: AdminAccessEntry) {
      return Effect.as(
        sqlEffect(sql, () =>
          sql.query(
            `
          INSERT INTO admin_access_log (actor, route, filter_summary)
          VALUES ($1, $2, $3::jsonb)
        `,
            [entry.actor, entry.route, JSON.stringify(entry.summary)],
          ),
        ),
        undefined,
      );
    },

    listAdminTraces(filter, page) {
      const where = whereOf(filter);
      // One statement: the window is computed over every matching row BEFORE the
      // LIMIT, so the page and the total it was drawn from cannot disagree — a row
      // inserted between two statements used to yield a "Next" that led nowhere.
      const rowsText = `SELECT${ROW_COLUMNS}, (COUNT(*) OVER ())::double precision AS total ${ROW_FROM}${where.text}
        ORDER BY created_at_ms DESC, t.id DESC
        LIMIT $${where.params.length + 1} OFFSET $${where.params.length + 2}`;
      // An empty page carries no window value (there is no row to read it from), so
      // only that case pays a second round trip.
      const countText = `SELECT COUNT(*)::double precision AS total ${ROW_FROM}${where.text}`;
      return Effect.flatMap(
        sqlEffect(
          sql,
          () =>
            sql.query(rowsText, [...where.params, page.limit, page.offset]) as Promise<
              (Row & { total: number | string })[]
            >,
        ),
        (rows) => {
          if (rows.length > 0) {
            return Effect.succeed<AdminTracePage>({
              rows: rows.map(toRow),
              total: Math.round(num(rows[0]?.total ?? 0)),
            });
          }
          return Effect.map(
            sqlEffect(
              sql,
              () => sql.query(countText, where.params) as Promise<{ total: number | string }[]>,
            ),
            (counted): AdminTracePage => ({
              rows: [],
              total: Math.round(num(counted[0]?.total ?? 0)),
            }),
          );
        },
      );
    },

    getAdminTrace(traceId) {
      return Effect.flatMap(
        sqlEffect(
          sql,
          () =>
            sql.query(`SELECT${ROW_COLUMNS}, t.trace ${ROW_FROM} AND t.id = $1::uuid LIMIT 1`, [
              traceId,
            ]) as Promise<(Row & { trace?: unknown })[]>,
        ),
        (rows) => {
          const [row] = rows;
          if (!row) return Effect.succeed<AdminTraceRecord | null>(null);
          return Effect.map(
            Effect.try({
              try: () => parseTrace(row.trace),
              catch: constraintError,
            }),
            (trace): AdminTraceRecord => ({ trace, row: toRow(row) }),
          );
        },
      );
    },

    getAdminTraceRaw(traceId) {
      // No `parseTrace`: the raw download exists to inspect a persisted shape the
      // current contract rejects, so parsing here would fail on exactly those rows.
      return Effect.map(
        sqlEffect(
          sql,
          () =>
            sql.query(`SELECT${ROW_COLUMNS}, t.trace ${ROW_FROM} AND t.id = $1::uuid LIMIT 1`, [
              traceId,
            ]) as Promise<(Row & { trace?: unknown })[]>,
        ),
        (rows): AdminTraceRawRecord | null => {
          const [row] = rows;
          return row ? { trace: row.trace, row: toRow(row) } : null;
        },
      );
    },

    purgeAdminAccessLog() {
      return Effect.map(
        sqlEffect(sql, () =>
          sql.query(
            `DELETE FROM admin_access_log
               WHERE accessed_at < now() - make_interval(days => $1::int)
               RETURNING id`,
            [ADMIN_ACCESS_LOG_RETENTION_DAYS],
          ),
        ),
        (rows) => rows.length,
      );
    },

    revokeAdminSession(revocation: AdminSessionRevocation) {
      // The token's own `exp`, converted once here so the row and the signature agree
      // on when the denylist entry stops mattering. A retried logout is a no-op: the
      // first write already proved the session ended.
      return Effect.as(
        sqlEffect(sql, () =>
          sql.query(
            `INSERT INTO admin_session_revocations (jti, expires_at)
             VALUES ($1, to_timestamp($2::double precision / 1000))
             ON CONFLICT (jti) DO NOTHING`,
            [revocation.jti, revocation.expiresAt],
          ),
        ),
        undefined,
      );
    },

    isAdminSessionRevoked(jti) {
      return Effect.map(
        sqlEffect(
          sql,
          () =>
            sql.query(
              `SELECT EXISTS (
                 SELECT 1 FROM admin_session_revocations WHERE jti = $1
               ) AS revoked`,
              [jti],
            ) as Promise<{ revoked?: boolean }[]>,
        ),
        (rows) => rows[0]?.revoked === true,
      );
    },

    purgeAdminSessionRevocations() {
      return Effect.map(
        sqlEffect(sql, () =>
          sql.query(
            `DELETE FROM admin_session_revocations
               WHERE expires_at < now()
               RETURNING jti`,
          ),
        ),
        (rows) => rows.length,
      );
    },
  };
}
