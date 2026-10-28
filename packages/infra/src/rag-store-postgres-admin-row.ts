import type { AdminTraceRow } from "./rag-store-admin-seam";

/**
 * The list and detail row projection (ADR-0064): the SQL that turns an `answer_traces`
 * row plus its transcript join into the browser's facts, and the mapping onto the wire
 * row. Kept beside the adapter that binds it so the SQL and `Row` are one edit. The SQL
 * is a template literal and `Row` is hand-written, so nothing ties them together at
 * compile time; `ROW_FIELDS` is pinned to `Row`'s fields by the compiler, and the
 * Postgres suite compares the columns `ROW_COLUMNS` actually projects with that list —
 * a column added on one side of the seam fails a gate instead of arriving as an
 * silently blank cell.
 *
 * `tot` is the per-message aggregate the list filters and displays; it sums **every**
 * event's cost record, so the embedding call is included exactly as it is in the
 * contract's `traceTotals`. The sums are cast to `double precision` because
 * node-postgres hands an `int8` back as a string, and a total that arrives as text is a
 * total someone will eventually sort lexicographically.
 */

/**
 * The answer's own clock: the trace records when the answer happened, and the row's
 * insert time is an implementation detail (a backfill or a replay would order by the
 * latter and hide the answer in the wrong day). Every read and every date bound uses
 * this one expression, so the filter and the column it compares can never disagree —
 * and a malformed trace degrades to the row time rather than failing the whole list.
 */
export const CREATED_AT_MS = `CASE
      WHEN t.trace->>'createdAt' ~ '^[0-9]+$' THEN (t.trace->>'createdAt')::double precision
      ELSE extract(epoch FROM t.created_at) * 1000
    END`;

export const ROW_COLUMNS = `
    t.id AS trace_id,
    t.message_id,
    ${CREATED_AT_MS} AS created_at_ms,
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
export const ROW_FROM = `
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

export type Row = {
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

/**
 * `Row`'s field names, one entry each. The mapped type is the compile-time link the
 * template-literal SQL cannot give: a field added to `Row` without its entry, or an
 * entry with no field, fails to type-check. `ROW_FIELDS` is the runtime list the
 * Postgres suite compares against the columns the SQL projects.
 */
const ROW_FIELD_NAMES: { readonly [K in keyof Row]: K } = {
  trace_id: "trace_id",
  message_id: "message_id",
  created_at_ms: "created_at_ms",
  question: "question",
  answer: "answer",
  intent: "intent",
  models: "models",
  refused: "refused",
  filter_relaxed: "filter_relaxed",
  tokens_in: "tokens_in",
  tokens_out: "tokens_out",
  latency_ms: "latency_ms",
  cost_micro_usd: "cost_micro_usd",
  estimated: "estimated",
};

export const ROW_FIELDS = Object.keys(ROW_FIELD_NAMES) as readonly (keyof Row)[];

/** node-postgres hands some numeric columns back as strings; one coercion, one place. */
export const num = (value: number | string | null): number => (value === null ? 0 : Number(value));

function modelsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function toRow(row: Row): AdminTraceRow {
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
