import { AdminTraceQuerySchema, type AdminTraceQuery } from "@app/contracts";
import type { AdminAccessSummary, AdminTraceFilter } from "@app/infra";
import type { AdminReadPlan } from "./admin-route";
import * as v from "valibot";

/**
 * The admin list query: parse, then project. One descriptor list owns the
 * dimensions the operator can filter by, so the filter (what the store searches
 * with) and the access summary (what the log records) cannot drift apart:
 *
 *  - `toFilter` is what the store searches with — it may carry the free text.
 *  - `toSummary` is what the append-only access log records — and it carries **no
 *    free text at all**. The operator's search string is typed against chat
 *    content, so recording it would put a fragment of a question in the log; and
 *    `intent`/`model` are operator free text too (bounded, not closed), so the
 *    summary records the same dimensions as `intentFiltered`/`modelFiltered`
 *    booleans.
 *
 * The projection is the guard, not the type: `AdminAccessSummary` also carries
 * `traceId?: string` (the opaque row id a detail read names), so a `toSummary`
 * that returned a string would compile. What keeps free text out is that every
 * projection here adds presence, pinned by the value-level test that walks a
 * recorded summary in `routes/admin.test.ts`.
 */

type FilterDimension = {
  readonly key: keyof AdminTraceQuery;
  /** The store's predicate for this dimension, when the query names it. */
  readonly toFilter: (query: AdminTraceQuery) => Partial<AdminTraceFilter>;
  /** The log's record of this dimension, when the query names it. */
  readonly toSummary: (query: AdminTraceQuery) => Partial<AdminAccessSummary>;
};

const FILTER_DIMENSIONS: readonly FilterDimension[] = [
  {
    key: "q",
    toFilter: (query) => (query.q === undefined ? {} : { text: query.q }),
    toSummary: (query) => (query.q === undefined ? {} : { textSearch: true }),
  },
  {
    key: "from",
    toFilter: (query) => (query.from === undefined ? {} : { from: query.from }),
    toSummary: (query) => (query.from === undefined ? {} : { from: query.from }),
  },
  {
    key: "to",
    toFilter: (query) => (query.to === undefined ? {} : { to: query.to }),
    toSummary: (query) => (query.to === undefined ? {} : { to: query.to }),
  },
  {
    key: "intent",
    toFilter: (query) => (query.intent === undefined ? {} : { intent: query.intent }),
    // Presence, not the operator's string: an intent free text would be an
    // unbounded field in the log by another name.
    toSummary: (query) => (query.intent === undefined ? {} : { intentFiltered: true }),
  },
  {
    key: "model",
    toFilter: (query) => (query.model === undefined ? {} : { model: query.model }),
    toSummary: (query) => (query.model === undefined ? {} : { modelFiltered: true }),
  },
  {
    key: "refused",
    toFilter: (query) => (query.refused === undefined ? {} : { refused: query.refused === "true" }),
    toSummary: (query) =>
      query.refused === undefined ? {} : { refused: query.refused === "true" },
  },
  {
    key: "filterRelaxed",
    toFilter: (query) =>
      query.filterRelaxed === undefined ? {} : { filterRelaxed: query.filterRelaxed === "true" },
    toSummary: (query) =>
      query.filterRelaxed === undefined ? {} : { filterRelaxed: query.filterRelaxed === "true" },
  },
  {
    key: "minLatencyMs",
    toFilter: (query) =>
      query.minLatencyMs === undefined ? {} : { minLatencyMs: query.minLatencyMs },
    toSummary: (query) =>
      query.minLatencyMs === undefined ? {} : { minLatencyMs: query.minLatencyMs },
  },
  {
    key: "minCostMicroUsd",
    toFilter: (query) =>
      query.minCostMicroUsd === undefined ? {} : { minCostMicroUsd: query.minCostMicroUsd },
    toSummary: (query) =>
      query.minCostMicroUsd === undefined ? {} : { minCostMicroUsd: query.minCostMicroUsd },
  },
];

/** The query keys the schema declares: the parser's whole accepted vocabulary. */
const QUERY_KEYS = Object.keys(AdminTraceQuerySchema.entries) as (keyof AdminTraceQuery)[];

/** Parse the query string into the contract's query, or refuse it. */
export function parseAdminQuery(
  searchParams: URLSearchParams,
): { ok: true; query: AdminTraceQuery } | { ok: false } {
  const raw: Record<string, string> = {};
  for (const key of QUERY_KEYS) {
    const value = searchParams.get(key);
    if (value !== null) raw[key] = value;
  }
  const parsed = v.safeParse(AdminTraceQuerySchema, raw);
  if (!parsed.success) return { ok: false };
  const query = parsed.output;
  if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
    return { ok: false };
  }
  return { ok: true, query };
}

/** The store's filter: every dimension the query names, including the free text. */
export function adminFilterOf(query: AdminTraceQuery): AdminTraceFilter {
  return Object.assign({}, ...FILTER_DIMENSIONS.map((dimension) => dimension.toFilter(query)));
}

/** The store's page window. Bounded by the query contract's `pageSize` ceiling. */
export function pageWindowOf(query: AdminTraceQuery): { limit: number; offset: number } {
  return { limit: query.pageSize, offset: (query.page - 1) * query.pageSize };
}

/**
 * What the access log records for a list read: every filter dimension the read was
 * narrowed by, the page, and whether a text filter ran — never the text itself, and
 * for the two free-text dimensions never the value either.
 */
export function accessSummaryOf(query: AdminTraceQuery): AdminAccessSummary {
  return Object.assign(
    { textSearch: false, page: query.page, pageSize: query.pageSize },
    ...FILTER_DIMENSIONS.map((dimension) => dimension.toSummary(query)),
  );
}

/** What the access log records for a single-trace read: the opaque row id read. */
export function traceAccessSummary(traceId: string): AdminAccessSummary {
  return { textSearch: false, traceId };
}

/** One list read, resolved from one parse: what the log records and what the store is
 * asked for, so the route cannot re-derive either from a value it already had. */
export type AdminListRead = {
  query: AdminTraceQuery;
  summary: AdminAccessSummary;
  filter: AdminTraceFilter;
  page: { limit: number; offset: number };
};

/** Parse and project one list read. `null` is a malformed query, which the caller answers
 * with a 400 — inside the guarded resolver, so the verdict is behind the credential
 * check. A malformed or out-of-range value is never a silently dropped filter: a filter
 * that degrades to "none" shows every message while the operator believes the list is
 * narrowed. */
export function parseAdminListRead(searchParams: URLSearchParams): AdminListRead | null {
  const parsed = parseAdminQuery(searchParams);
  if (!parsed.ok) return null;
  return {
    query: parsed.query,
    summary: accessSummaryOf(parsed.query),
    filter: adminFilterOf(parsed.query),
    page: pageWindowOf(parsed.query),
  };
}

/** The plan both trace routes share: validate the id, log the read. An id the uuid column
 * cannot hold and an id that names no row are one answer — `404 not_found`. */
export function traceReadPlan(traceId: string): AdminReadPlan<string> {
  return isTraceRowId(traceId)
    ? { summary: traceAccessSummary(traceId), read: traceId }
    : { refuse: { status: 404, error: "not_found" } };
}

/** Can this value name an `answer_traces` row? The column is a uuid, so a value the
 * cast cannot hold is answered as "no such trace" rather than reaching the adapter. */
export function isTraceRowId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
