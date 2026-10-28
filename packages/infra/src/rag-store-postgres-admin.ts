import type { Trace } from "@app/contracts";
import { Effect } from "effect";
import {
  ADMIN_ACCESS_LOG_RETENTION_DAYS,
  type AdminAccessEntry,
  type AdminTraceFilter,
  type AdminTracePage,
  type AdminTraceRecord,
  type AdminTraceRow,
  type RagStoreAdmin,
} from "./rag-store-admin-seam";
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

/**
 * The row projection and its fixed joins. `tot` is the per-message aggregate the
 * list filters and displays; it sums **every** event's cost record, so the
 * embedding call is included exactly as it is in the contract's `traceTotals`.
 * The sums are cast to `double precision` because node-postgres hands an `int8`
 * back as a string, and a total that arrives as text is a total someone will
 * eventually sort lexicographically.
 */
const ROW_COLUMNS = `
    t.id AS trace_id,
    t.message_id,
    (extract(epoch FROM t.created_at) * 1000)::double precision AS created_at_ms,
    COALESCE(uq.content, '') AS question,
    m.content AS answer,
    (
      SELECT ie->'detail'->>'intent'
      FROM jsonb_array_elements(t.trace->'events') WITH ORDINALITY AS ev(ie, ord)
      WHERE ie->>'kind' = 'intent'
      ORDER BY ev.ord
      LIMIT 1
    ) AS intent,
    (
      SELECT COALESCE(jsonb_agg(mid ORDER BY first_ord), '[]'::jsonb)
      FROM (
        SELECT ev.e->'cost'->>'modelId' AS mid, MIN(ev.ord) AS first_ord
        FROM jsonb_array_elements(t.trace->'events') WITH ORDINALITY AS ev(e, ord)
        WHERE ev.e->'cost' IS NOT NULL
        GROUP BY 1
      ) models_in_order
    ) AS models,
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(t.trace->'events') AS ev(e)
      WHERE e->>'kind' = 'refusal'
    ) AS refused,
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(t.trace->'events') AS ev(e)
      WHERE e->>'kind' = 'filter_relaxed'
        AND COALESCE(e->'detail'->>'adopted', 'true') <> 'false'
    ) AS filter_relaxed,
    COALESCE(tot.tokens_in, 0) AS tokens_in,
    COALESCE(tot.tokens_out, 0) AS tokens_out,
    COALESCE(tot.latency_ms, 0) AS latency_ms,
    COALESCE(tot.cost_micro_usd, 0) AS cost_micro_usd,
    COALESCE(tot.estimated, false) AS estimated`;

/** The fixed joins every row read shares — content from the transcript, facts and
 * totals from the trace. `uq` is the question row, `tot` the per-message aggregate. */
const ROW_FROM = `
  FROM answer_traces t
  JOIN chat_messages m ON m.id::text = t.message_id
  LEFT JOIN LATERAL (
    SELECT q.content
    FROM chat_messages q
    WHERE q.session_id = m.session_id
      AND q.role = 'user'
      AND q.created_at <= m.created_at
    ORDER BY q.created_at DESC, q.id DESC
    LIMIT 1
  ) uq ON true
  LEFT JOIN LATERAL (
    SELECT
      SUM((e->'cost'->>'tokensIn')::double precision) AS tokens_in,
      SUM((e->'cost'->>'tokensOut')::double precision) AS tokens_out,
      SUM((e->'cost'->>'latencyMs')::double precision) AS latency_ms,
      SUM((e->'cost'->>'costMicroUsd')::double precision) AS cost_micro_usd,
      bool_or((e->'cost'->>'estimated')::boolean) AS estimated
    FROM jsonb_array_elements(t.trace->'events') AS ev(e)
    WHERE e->'cost' IS NOT NULL
  ) tot ON true
  WHERE m.role = 'assistant'`;

type Row = {
  trace_id: string;
  message_id: string;
  created_at_ms: number | string;
  question: string | null;
  answer: string | null;
  intent: string | null;
  models: unknown;
  refused: boolean | null;
  filter_relaxed: boolean | null;
  tokens_in: number | string | null;
  tokens_out: number | string | null;
  latency_ms: number | string | null;
  cost_micro_usd: number | string | null;
  estimated: boolean | null;
};

const num = (value: number | string | null): number => (value === null ? 0 : Number(value));

function modelsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function toRow(row: Row): AdminTraceRow {
  return {
    traceId: row.trace_id,
    messageId: row.message_id,
    createdAt: Math.round(num(row.created_at_ms)),
    question: row.question ?? "",
    answer: row.answer ?? "",
    intent: row.intent,
    models: modelsOf(row.models),
    refused: row.refused === true,
    filterRelaxed: row.filter_relaxed === true,
    totals: {
      tokensIn: Math.round(num(row.tokens_in)),
      tokensOut: Math.round(num(row.tokens_out)),
      latencyMs: num(row.latency_ms),
      costMicroUsd: Math.round(num(row.cost_micro_usd)),
      estimated: row.estimated === true,
    },
  };
}

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
    parts.push(`t.created_at >= to_timestamp(${bind(filter.from)} / 1000.0)`);
  }
  if (filter.to !== undefined) {
    parts.push(`t.created_at <= to_timestamp(${bind(filter.to)} / 1000.0)`);
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
  "recordAdminAccess" | "listAdminTraces" | "getAdminTrace" | "purgeAdminAccessLog"
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
      const rowsParams = [...where.params, page.limit, page.offset];
      const rowsText = `SELECT${ROW_COLUMNS} ${ROW_FROM}${where.text}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $${where.params.length + 1} OFFSET $${where.params.length + 2}`;
      const countText = `SELECT COUNT(*)::double precision AS total ${ROW_FROM}${where.text}`;
      return Effect.flatMap(
        sqlEffect(sql, () => sql.query(rowsText, rowsParams) as Promise<Row[]>),
        (rows) =>
          Effect.map(
            sqlEffect(
              sql,
              () => sql.query(countText, where.params) as Promise<{ total: number | string }[]>,
            ),
            (counted): AdminTracePage => ({
              rows: rows.map(toRow),
              total: Math.round(num(counted[0]?.total ?? 0)),
            }),
          ),
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
              try: () => parseTrace(row.trace) as Trace,
              catch: constraintError,
            }),
            (trace): AdminTraceRecord => ({ trace, row: toRow(row) }),
          );
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
  };
}
