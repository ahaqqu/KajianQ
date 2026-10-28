import { AdminTraceQuerySchema, type AdminTraceQuery } from "@app/contracts";
import type { AdminAccessSummary, AdminTraceFilter } from "@app/infra";
import * as v from "valibot";

/**
 * The admin list query: parse, then project. Two projections, deliberately
 * separated:
 *
 *  - `adminFilterOf` is what the store searches with — it carries the free text.
 *  - `accessSummaryOf` is what the append-only access log records — and it carries
 *    **no free text at all**. The operator's search string is typed against chat
 *    content, so recording it would put a fragment of a question in the log. The
 *    summary keeps the fact that a text filter ran (`textSearch`) and nothing more;
 *    the type has no field a string could travel in, so the log cannot accumulate
 *    content even by a future edit that forgets this rule.
 */

/** Parse the query string. A malformed or out-of-range value is a 400, never a
 * silently dropped filter: a filter that degrades to "none" shows every message
 * while the operator believes the list is narrowed. */
export function parseAdminQuery(
  searchParams: URLSearchParams,
): { ok: true; query: AdminTraceQuery } | { ok: false } {
  const raw: Record<string, string> = {};
  for (const key of [
    "q",
    "from",
    "to",
    "intent",
    "model",
    "refused",
    "filterRelaxed",
    "minLatencyMs",
    "minCostMicroUsd",
    "page",
    "pageSize",
  ]) {
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
  return {
    ...(query.q !== undefined ? { text: query.q } : {}),
    ...(query.from !== undefined ? { from: query.from } : {}),
    ...(query.to !== undefined ? { to: query.to } : {}),
    ...(query.intent !== undefined ? { intent: query.intent } : {}),
    ...(query.model !== undefined ? { model: query.model } : {}),
    ...(query.refused !== undefined ? { refused: query.refused === "true" } : {}),
    ...(query.filterRelaxed !== undefined ? { filterRelaxed: query.filterRelaxed === "true" } : {}),
    ...(query.minLatencyMs !== undefined ? { minLatencyMs: query.minLatencyMs } : {}),
    ...(query.minCostMicroUsd !== undefined ? { minCostMicroUsd: query.minCostMicroUsd } : {}),
  };
}

/** The store's page window. Bounded by the query contract's `pageSize` ceiling. */
export function pageWindowOf(query: AdminTraceQuery): { limit: number; offset: number } {
  return { limit: query.pageSize, offset: (query.page - 1) * query.pageSize };
}

/**
 * What the access log records for a list read: every filter dimension the read was
 * narrowed by, the page, and whether a text filter ran — never the text itself.
 */
export function accessSummaryOf(query: AdminTraceQuery): AdminAccessSummary {
  return {
    textSearch: query.q !== undefined,
    ...(query.from !== undefined ? { from: query.from } : {}),
    ...(query.to !== undefined ? { to: query.to } : {}),
    ...(query.intent !== undefined ? { intent: query.intent } : {}),
    ...(query.model !== undefined ? { model: query.model } : {}),
    ...(query.refused !== undefined ? { refused: query.refused === "true" } : {}),
    ...(query.filterRelaxed !== undefined ? { filterRelaxed: query.filterRelaxed === "true" } : {}),
    ...(query.minLatencyMs !== undefined ? { minLatencyMs: query.minLatencyMs } : {}),
    ...(query.minCostMicroUsd !== undefined ? { minCostMicroUsd: query.minCostMicroUsd } : {}),
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** What the access log records for a single-trace read: the opaque row id read. */
export function traceAccessSummary(traceId: string): AdminAccessSummary {
  return { textSearch: false, traceId };
}

/** Can this value name an `answer_traces` row? The column is a uuid, so a value the
 * cast cannot hold is answered as "no such trace" rather than reaching the adapter. */
export function isTraceRowId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
