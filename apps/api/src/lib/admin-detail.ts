import {
  ChatTraceFrameSchema,
  traceProviderCalls,
  type AdminTraceDetail,
  type ChatTraceFrame,
  type Trace,
} from "@app/contracts";
import type { AdminTraceRow } from "@app/infra";
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
    calls: traceProviderCalls(trace),
    frame,
  };
}

/**
 * Resolve one trace and build its detail payload. `null` is "no such row" — the
 * route answers a 404, indistinguishably for an unknown id and a malformed one.
 */
export async function adminTracePayload(input: {
  store: StoreWiring;
  traceId: string;
  warn: Warn;
}): Promise<{ detail: AdminTraceDetail; trace: Trace } | null> {
  const record = await input.store.runStore(input.store.fullStore.getAdminTrace(input.traceId));
  if (record === null) return null;
  const detail = await adminTraceDetail({
    row: record.row,
    trace: record.trace,
    fetchChunks: chunkFetcher(input.store.fullStore, input.store.runStore),
    warn: input.warn,
  });
  return { detail, trace: record.trace };
}
