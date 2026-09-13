import {
  ChatTraceFrameSchema,
  type ChatTraceChunk,
  type ChatTraceFrame,
  type Trace,
} from "@app/contracts";
import type { DocChildById, RagStore } from "@app/infra";
import type { StoreBridge } from "@app/kajianq-domain";
import * as v from "valibot";

/**
 * The user-facing Trace frame (#12, ADR-0007) — the invariant this module
 * owns: **the panel is derived from the persisted answer trace, never
 * reconstructed client-side.** The top "sources consulted" layer and the
 * technical layer (router intent, sub-queries, chunks with scores, model
 * identities) both come from the trace's own typed events; the only store
 * join is the display title per chunk, resolved by the same chunk ids the
 * trace references. The client renders the frame or nothing — it never
 * interprets raw trace events (the same posture the citations frame takes,
 * ADR-0040).
 *
 * Degradation is honest by omission: a chunk row (or its title) that fails
 * to resolve simply loses its `source` field and renders by id — the panel
 * never invents display data.
 */

/** Display-data fetcher over the store seam (the bridge stays at the edge). */
export type CitationChunkSource = (ids: readonly string[]) => Promise<readonly DocChildById[]>;

/** The structured-warning callback both derivation entries share. */
export type Warn = (msg: string, fields?: Record<string, string | number | boolean | null>) => void;

/** Bind a {@link CitationChunkSource} to a wired store + its Effect bridge. */
export function chunkFetcher(
  store: Pick<RagStore, "getDocChildrenByIds">,
  runStore: StoreBridge,
): CitationChunkSource {
  return async (ids) => runStore(store.getDocChildrenByIds(ids));
}

/**
 * The trace's retrieval chunk refs, in retrieval order, deduplicated by id —
 * carrying each ref's fused score and channel ranks for the technical layer.
 */
export function traceChunkRefs(trace: Trace): ChunkRef[] {
  const refs: ChunkRef[] = [];
  const seen = new Set<string>();
  for (const event of trace.events) {
    if (event.kind !== "retrieval") continue;
    for (const ref of event.detail.chunks) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      refs.push(ref);
    }
  }
  return refs;
}

/** The trace's retrieval chunk ids, in retrieval order, deduplicated. */
export function traceChunkIds(trace: Trace): string[] {
  return traceChunkRefs(trace).map((ref) => ref.id);
}

/** The persisted trace's retrieval ref shape (contracts `ChunkRef`). */
type ChunkRef = {
  id: string;
  score?: number | undefined;
  rankDense?: number | undefined;
  rankSparse?: number | undefined;
};

/** The chunk's display title, when the store row resolves with a non-empty one. */
function sourceTitleOf(row: DocChildById | undefined): string | undefined {
  const title = row?.parentTitle;
  return typeof title === "string" && title.trim() !== "" ? title : undefined;
}

/** Map one ref to its top-layer source entry (id + title, no scores). */
function toSource(ref: ChunkRef, chunksById: ReadonlyMap<string, DocChildById>): ChatTraceChunk {
  const source = sourceTitleOf(chunksById.get(ref.id));
  return { id: ref.id, ...(source !== undefined ? { source } : {}) };
}

/** Map one ref to its technical-layer entry (id + title + retrieval provenance). */
function toTechnicalChunk(
  ref: ChunkRef,
  chunksById: ReadonlyMap<string, DocChildById>,
): ChatTraceChunk {
  const source = sourceTitleOf(chunksById.get(ref.id));
  return {
    id: ref.id,
    ...(source !== undefined ? { source } : {}),
    ...(ref.score !== undefined ? { score: ref.score } : {}),
    ...(ref.rankDense !== undefined ? { rankDense: ref.rankDense } : {}),
    ...(ref.rankSparse !== undefined ? { rankSparse: ref.rankSparse } : {}),
  };
}

/**
 * Pure core: derive the two-layer Trace frame from a persisted trace and the
 * display rows of the trace's chunks. Refusals carry no retrieval events, so
 * their frame is legitimately empty (the UI says "no sources consulted" —
 * honest, not an error). Parsed against the contract by the callers, exactly
 * as the citations derivation is.
 */
export function deriveTraceFrame(input: {
  trace: Trace;
  messageId: string;
  chunksById: ReadonlyMap<string, DocChildById>;
}): ChatTraceFrame {
  const { trace, messageId, chunksById } = input;
  const refs = traceChunkRefs(trace);
  const intentEvent = trace.events.find((event) => event.kind === "intent");
  const subQueries = trace.events
    .filter(
      (event): event is Extract<typeof event, { kind: "subquery" }> => event.kind === "subquery",
    )
    .map((event) => event.detail.text);
  const models: string[] = [];
  for (const event of trace.events) {
    const modelId = event.cost?.modelId;
    if (modelId !== undefined && !models.includes(modelId)) models.push(modelId);
  }
  return {
    messageId,
    sources: refs.map((ref) => toSource(ref, chunksById)),
    technical: {
      ...(intentEvent !== undefined
        ? {
            intent: intentEvent.detail.intent,
            ...(intentEvent.detail.confidence !== undefined
              ? { confidence: intentEvent.detail.confidence }
              : {}),
          }
        : {}),
      subQueries,
      chunks: refs.map((ref) => toTechnicalChunk(ref, chunksById)),
      models,
    },
  };
}

/**
 * The shared degrade-and-derive fetch: resolve display rows for the given
 * chunk ids, degrading to an EMPTY map on failure — never a fabricated one —
 * with the caller's structured warning. (Owner module for the helper the
 * citations derivation shares, thermo-review B1's one-owner policy.)
 */
export async function chunksByIdOrEmpty(input: {
  ids: readonly string[];
  fetchChunks: CitationChunkSource;
  warn: Warn;
  warnKey: string;
  warnFields: Record<string, string | number | boolean | null>;
}): Promise<ReadonlyMap<string, DocChildById>> {
  try {
    const chunks = await input.fetchChunks(input.ids);
    return new Map<string, DocChildById>(chunks.map((c) => [c.id, c]));
  } catch (err) {
    // Degrade honestly: no titles, not wrong titles. Ops sees why.
    input.warn(input.warnKey, {
      ...input.warnFields,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map<string, DocChildById>();
  }
}

/**
 * The route-level entry: derive the Trace frame from the just-persisted
 * trace, resolving display data through the store seam. A store-read failure
 * degrades to id-only entries (never fabricated titles) with a structured
 * warning; the frame is parsed against the contract before it touches the
 * wire.
 */
export async function traceFrameFor(input: {
  trace: Trace;
  messageId: string;
  fetchChunks: CitationChunkSource;
  warn: Warn;
}): Promise<ChatTraceFrame> {
  const { trace, messageId, fetchChunks, warn } = input;
  const chunksById = await chunksByIdOrEmpty({
    ids: traceChunkIds(trace),
    fetchChunks,
    warn,
    warnKey: "chat.trace.chunk_lookup_failed",
    warnFields: { messageId },
  });
  return v.parse(ChatTraceFrameSchema, deriveTraceFrame({ trace, messageId, chunksById }));
}
