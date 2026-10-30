import {
  AdminTraceListSchema,
  ChatTraceFrameSchema,
  ModelPriceSchema,
  traceProviderCalls,
  type AdminCallModelMatch,
  type AdminTraceCall,
  type AdminTraceDetail,
  type AdminTraceList,
  type AdminTraceListItem,
  type AdminTraceQuery,
  type ChatTraceFrame,
  type Trace,
  type TraceProviderCall,
} from "@app/contracts";
import { computeCost, StoreError, type AdminTraceRow, type ModelConfigRecord } from "@app/infra";
import type { StoreWiring } from "./chat-wiring";
import * as v from "valibot";
import {
  chunkFetcher,
  chunksByIdOrEmpty,
  deriveTraceFrame,
  narratorFetcher,
  narratorNamesOrEmpty,
  recordedEvidence,
  traceChunkIds,
  type CitationChunkSource,
  type NarratorSource,
  type Warn,
} from "./chat-trace";

/** The mirror row's price carrier: the one payload field this module reads. */
const MirrorPricePayloadSchema = v.object({ priceMicroUsdPerMTok: ModelPriceSchema });

/**
 * A mirror row names a call's model but its payload carries no price the contract can
 * read. That is not "the model is not in the config" (`unresolved`): the mirror does
 * name the model, so the detail refuses the read rather than print a false sentence.
 * The drift gate makes this unreachable while the derived payload and this reader
 * agree; the typed failure is what keeps a later payload edit from degrading silently.
 */
export class ModelConfigPayloadError extends Error {
  /** `role/provider/model` of the row the caller could not read, for the structural log. */
  readonly key: string;

  constructor(row: ModelConfigRecord) {
    super(`model_configs row ${row.role}/${row.provider}/${row.modelId} has no readable price`);
    this.name = "ModelConfigPayloadError";
    this.key = `${row.role}/${row.provider}/${row.modelId}`;
  }
}

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

/** One mirror price, read strictly: an unreadable payload throws rather than looking
 * like a model the config does not name. The drift check compares the payload
 * canonically before this runs, so a failure here means the row is not the derived
 * shape the caller believed it read. */
function priceOf(row: ModelConfigRecord): { in: number; out: number } {
  const parsed = v.safeParse(MirrorPricePayloadSchema, row.config);
  if (!parsed.success) throw new ModelConfigPayloadError(row);
  return parsed.output.priceMicroUsdPerMTok;
}

/**
 * The mirror's candidates for one call's model id, collapsed by `(provider, price)` so
 * the roles sharing a model on the same terms are one match rather than one per role.
 * A model id can legitimately live on two rows with different terms (the free-tier and
 * paid-terms embedding rows), which is why this is a list and not a single provider.
 */
function mirrorMatches(
  rows: readonly ModelConfigRecord[],
  modelId: string,
  call: TraceProviderCall,
): AdminCallModelMatch[] {
  const groups = new Map<
    string,
    { provider: string; price: { in: number; out: number }; roles: Set<string> }
  >();
  for (const row of rows) {
    if (row.modelId !== modelId) continue;
    const price = priceOf(row);
    const key = `${row.provider}\u0000${price.in}\u0000${price.out}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { provider: row.provider, price, roles: new Set([row.role]) });
    } else {
      group.roles.add(row.role);
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map((group) => {
      const computed = computeCost(
        modelId,
        group.price,
        call.tokensIn,
        call.tokensOut,
        call.latencyMs,
      ).costMicroUsd;
      return {
        provider: group.provider,
        roles: [...group.roles].sort(),
        priceMicroUsdPerMTok: group.price,
        computedCostMicroUsd: computed,
        // The recorded figure stays the call's cost; this says whether the config's
        // price accounts for it, using the adapter's own ceiling arithmetic.
        consistent: computed === call.costMicroUsd,
      };
    });
}

/**
 * One recorded provider call plus its model identity and cost consistency from the
 * mirror. `consistent` when a mirrored price reproduces the recorded figure,
 * `mismatch` when the model is mirrored but none does, `unresolved` when no row names
 * the id — an older trace whose model the config no longer carries, reported rather
 * than hidden or turned into a failed read. A row that DOES name the id but carries no
 * readable price throws `ModelConfigPayloadError`: the mirror names the model, so
 * reporting `unresolved` would be a false sentence and the read is refused instead.
 */
export function adminTraceCallOf(
  call: TraceProviderCall,
  rows: readonly ModelConfigRecord[],
): AdminTraceCall {
  const matches = mirrorMatches(rows, call.modelId, call);
  const status =
    matches.length === 0
      ? "unresolved"
      : matches.some((match) => match.consistent)
        ? "consistent"
        : "mismatch";
  return { ...call, modelConfig: { status, matches } };
}

/**
 * The admin detail payload (ADR-0064): a message's own fields, its per-message
 * totals, its per-provider-call list with each call's model identity and pricing
 * consistency, and the Trace panel frame.
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
 * claims to sum. The mirror half is additive: it never replaces a recorded cost, it
 * explains which mirrored price reproduces it.
 */
export async function adminTraceDetail(input: {
  row: AdminTraceRow;
  trace: Trace;
  /** The mirror rows the caller verified against the config — never a stale set. */
  modelConfigs: readonly ModelConfigRecord[];
  fetchChunks: CitationChunkSource;
  /** The narrator display join; absent renders catalogue ids in place of names. */
  fetchNarrators?: NarratorSource;
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
  const narratorNames = await narratorNamesOrEmpty({
    ids: recordedEvidence(trace)?.narratorIds ?? [],
    fetchNarrators: input.fetchNarrators,
    warn: input.warn,
    warnKey: "admin.trace_narrators_unresolved",
    warnFields: { traceId: row.traceId },
  });
  const frame: ChatTraceFrame = v.parse(
    ChatTraceFrameSchema,
    deriveTraceFrame({ trace, messageId: row.messageId, chunksById, narratorNames }),
  );
  return {
    ...adminTraceItemOf(row),
    calls: traceProviderCalls(trace).map((call) => adminTraceCallOf(call, input.modelConfigs)),
    frame,
  };
}

/** One trace lookup's outcome. `unparseable` is the stored shape this contract cannot
 * read: the raw download serves it, the structured detail names the condition.
 * `unreadable` is a mirror row whose payload this contract cannot read: the mirror
 * names the requested model, so the detail refuses rather than reporting it absent. */
export type AdminTraceLookup =
  | { kind: "found"; detail: AdminTraceDetail; trace: Trace }
  | { kind: "missing" }
  | { kind: "unparseable" }
  | { kind: "unreadable"; key: string };

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
  modelConfigs: readonly ModelConfigRecord[];
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
  try {
    const detail = await adminTraceDetail({
      row: record.row,
      trace: record.trace,
      modelConfigs: input.modelConfigs,
      fetchChunks: chunkFetcher(input.store.fullStore, input.store.runStore),
      fetchNarrators: narratorFetcher(input.store.fullStore, input.store.runStore),
      warn: input.warn,
    });
    return { kind: "found", detail, trace: record.trace };
  } catch (err) {
    if (err instanceof ModelConfigPayloadError) return { kind: "unreadable", key: err.key };
    throw err;
  }
}
