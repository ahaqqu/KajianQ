import {
  AdminTraceListSchema,
  ChatTraceFrameSchema,
  traceProviderCalls,
  type AdminTraceDetail,
  type AdminTraceList,
  type AdminTraceListItem,
  type AdminTraceQuery,
  type ChatTraceFrame,
  type Trace,
} from "@app/contracts";
import { StoreError, type AdminTraceRow } from "@app/infra";
import type { StoreWiring } from "./chat-wiring";
import * as v from "valibot";
import {
  chunkFetcher,
  chunksByIdOrEmpty,
  deriveTraceFrame,
  traceChunkIds,
  type CitationChunkSource,
  type Warn,
} from "./chat-trace";

/**
 * The message half of an admin payload — the one projection of an `AdminTraceRow` onto
 * the wire item, used by the list AND the detail. The contract declares the detail as
 * this shape plus its trace-derived halves, so a fact added to the row reaches both
 * payloads or neither.
 */
export function adminTraceItemOf(row: AdminTraceRow): AdminTraceListItem {
  return {
    traceId: row.traceId,
    messageId: row.messageId,
    createdAt: row.createdAt,
    question: row.question,
    answer: row.answer,
    ...(row.intent !== null ? { intent: row.intent } : {}),
    models: [...row.models],
    refused: row.refused,
    filterRelaxed: row.filterRelaxed,
    totals: row.totals,
  };
}

/** The list payload: one page of items, its page window, the store's total. Parsed against
 * the contract before it ships, and built from the same item projection the detail uses. */
export function adminTraceListOf(input: {
  rows: readonly AdminTraceRow[];
  query: AdminTraceQuery;
  total: number;
}): AdminTraceList {
  return v.parse(AdminTraceListSchema, {
    items: input.rows.map(adminTraceItemOf),
    page: input.query.page,
    pageSize: input.query.pageSize,
    total: input.total,
  });
}

/**
 * The admin detail payload (ADR-0064): a message's own fields, its per-message
 * totals, its per-provider-call list, and the Trace panel frame.
 *
 * The frame is produced by the SAME `deriveTraceFrame` derivation the user-facing
 * panel renders and parsed against the same `ChatTraceFrameSchema` — the admin view
 * is a second consumer of the one derivation, never a second renderer. A chunk row
 * that fails to resolve degrades to an id-only row exactly as it does in the chat
 * panel, with the failure logged.
 *
 * The totals and calls come from the trace's own cost records through the shared
 * contract functions, so the list's SQL aggregate, the detail's totals, and the
 * per-call rows are one arithmetic: a total can never disagree with the calls it
 * claims to sum.
 */
export async function adminTraceDetail(input: {
  row: AdminTraceRow;
  trace: Trace;
  fetchChunks: CitationChunkSource;
  warn: Warn;
}): Promise<AdminTraceDetail> {
  const { row, trace } = input;
  const chunksById = await chunksByIdOrEmpty({
    ids: traceChunkIds(trace),
    fetchChunks: input.fetchChunks,
    warn: input.warn,
    warnKey: "admin.trace_chunks_unresolved",
    warnFields: { traceId: row.traceId },
  });
  const frame: ChatTraceFrame = v.parse(
    ChatTraceFrameSchema,
    deriveTraceFrame({ trace, messageId: row.messageId, chunksById }),
  );
  return {
    ...adminTraceItemOf(row),
    calls: traceProviderCalls(trace),
    frame,
  };
}

/** One trace lookup's outcome. `unparseable` is the stored shape this contract cannot
 * read: the raw download serves it, the structured detail names the condition. */
export type AdminTraceLookup =
  | { kind: "found"; detail: AdminTraceDetail; trace: Trace }
  | { kind: "missing" }
  | { kind: "unparseable" };

/**
 * Resolve one trace and build its detail payload. `missing` is "no such row" — the route
 * answers a 404, indistinguishably for an unknown id and a malformed one — and
 * `unparseable` is the adapter's `constraint` failure, which the route answers with a
 * status that means it rather than a generic 500. The raw route reads the same row
 * unparsed, so the escape hatch keeps working on exactly these rows.
 */
export async function adminTracePayload(input: {
  store: StoreWiring;
  traceId: string;
  warn: Warn;
}): Promise<AdminTraceLookup> {
  let record;
  try {
    record = await input.store.runStore(input.store.fullStore.getAdminTrace(input.traceId));
  } catch (err) {
    if (err instanceof StoreError && err.kind === "constraint") return { kind: "unparseable" };
    throw err;
  }
  if (record === null) return { kind: "missing" };
  const detail = await adminTraceDetail({
    row: record.row,
    trace: record.trace,
    fetchChunks: chunkFetcher(input.store.fullStore, input.store.runStore),
    warn: input.warn,
  });
  return { kind: "found", detail, trace: record.trace };
}
