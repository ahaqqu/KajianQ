import {
  type ChatTraceChunk,
  type ChatTraceFrame,
  type ChunkRef,
  type Trace,
} from "@app/contracts";
import type { DocChildById, RagStore } from "@app/infra";
import type { StoreBridge } from "@app/kajianq-domain";

/**
 * The user-facing Trace frame (ADR-0007) — the invariant this module owns:
 * **the panel is derived from the persisted answer trace, never reconstructed
 * client-side.** Both layers come from the trace's own typed events; the only
 * store join is the display title per chunk, resolved by the same chunk ids the
 * trace references. The client renders the frame or nothing — it never
 * interprets raw trace events (the same posture the citations frame takes,
 * ADR-0040).
 *
 * Degradation is honest by omission: a chunk row (or its title) that fails to
 * resolve simply loses its `source` field and renders by id — the panel never
 * invents display data.
 */

/** Display-data fetcher over the store seam (the bridge stays at the edge). */
export type CitationChunkSource = (ids: readonly string[]) => Promise<readonly DocChildById[]>;

export type Warn = (msg: string, fields?: Record<string, string | number | boolean | null>) => void;

export function chunkFetcher(
  store: Pick<RagStore, "getDocChildrenByIds">,
  runStore: StoreBridge,
): CitationChunkSource {
  return async (ids) => runStore(store.getDocChildrenByIds(ids));
}

/** The trace's retrieval chunk refs, in retrieval order, deduplicated by id. */
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

export function traceChunkIds(trace: Trace): string[] {
  return traceChunkRefs(trace).map((ref) => ref.id);
}

/**
 * True when the trace records a refusal decision — a `refusal` event with its
 * trigger, the same signal the eval harness's refusal detection reads
 * (ADR-0007). ONE owner for "is the delivered text the product's own rather
 * than a draft?": both the citations frame's flag (`chat-citations.ts`) and the
 * route's chunking branch (`chat.ts`) ask it, so the two spellings cannot drift
 * apart. The writer is not always the reviewer: a run whose route carries no
 * question is declined by the runner and records the same event kind, because
 * the fact the kind carries — the user gets product copy, not a model's draft —
 * is the same one.
 *
 * The trigger→delivery map this predicate relies on, stated once here for every
 * reader of it (`chat.ts`'s chunking branch included): a `generator_refusal`
 * returns the draft — the pure refusal unchanged, the hybrid through the Always
 * rules — so the settled text must be chunked; **anything else REPLACES the
 * delivered text with product copy** and must not replay the vendor's deltas.
 * The replacement triggers today are `ungrounded_citation` (the deterministic
 * gate), `reviewer_fail` (the paid reviewer), `asserting_refusal_draft` (the
 * decline backstop) and `content_free_decline` (the runner's decline of a route
 * that carries no question at all); adding one keeps this invariant, which is
 * why the route asks this predicate rather than the trigger value. The
 * vocabulary itself has one owner: `RefusalTrigger` in `@app/kajianq-domain`
 * (`chat-refusal.ts`).
 */
export function traceRefused(trace: Trace): boolean {
  return trace.events.some((event) => event.kind === "refusal");
}

/** The chunk's display title, when the store row resolves with a non-empty one. */
function sourceTitleOf(row: DocChildById | undefined): string | undefined {
  const title = row?.parentTitle;
  return typeof title === "string" && title.trim() !== "" ? title : undefined;
}

function toSource(ref: ChunkRef, chunksById: ReadonlyMap<string, DocChildById>): ChatTraceChunk {
  const source = sourceTitleOf(chunksById.get(ref.id));
  return { id: ref.id, ...(source !== undefined ? { source } : {}) };
}

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
    // The decision model's probability, when a rerank applied: the panel lists the
    // retrieval order — led by the caller-priority guarantee — and this number
    // explains the fused block's order within it, beside the fused score. The
    // assembled prompt re-sorts by presentation slot, so neither number is a
    // prompt position.
    ...(ref.rerankScore !== undefined ? { rerankScore: ref.rerankScore } : {}),
    // The ref's opaque origin label, when the trace carries one: a chunk an arm
    // added has no score or channel ranks, so this field is the only thing that
    // tells the panel why it is in context; a promoted fused row says so too
    // (ADR-0062) rather than reading as an addition.
    ...(ref.origin !== undefined ? { origin: ref.origin } : {}),
  };
}

/**
 * Pure core: derive the two-layer Trace frame from a persisted trace and the
 * display rows of the trace's chunks. A PURE refusal's trace carries no
 * retrieval events, so its frame is legitimately empty (the UI says "no
 * sources consulted" — honest, not an error). A HYBRID refusal is a refusal
 * recorded over a partial answer, so it carries the retrieval refs that answer
 * was built from and its panel is populated — the panel reports what was
 * consulted, never whether the run decided to refuse. Parsed against the
 * contract by the callers, exactly as the citations derivation is. The live
 * route's combined entry (one shared store read for both frames) is
 * `answerFramesFor` in `chat-citations.ts` — this module stays below it in the
 * import graph.
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
  // The routing decision, projected verbatim from the persisted trace:
  // which sources the route selected and the filter record it decided retrieval
  // should run with. Opaque strings — this module names neither a source type
  // nor a filter dimension. Absent on traces persisted before the event
  // existed, and on a trace with no routing event the frame omits the block
  // rather than claiming "no sources were searched" (an EMPTY `sources` list
  // says that, explicitly).
  const routingEvent = trace.events.find((event) => event.kind === "source_routing");
  // ... and the dimensions the run actually GAVE UP, from the retriever's own
  // `filter_relaxed` events. Without them the block shows a filter the search had
  // already dropped, so a hint the store did not honour reads as a filter that
  // ran. `adopted: false` is a probe that changed nothing (machinery, not a
  // relaxation); an absent `adopted` is a trace persisted before probing, where
  // every recorded drop was applied.
  const relaxed: { key: string; values: string[] }[] = [];
  for (const event of trace.events) {
    if (event.kind !== "filter_relaxed" || event.detail.adopted === false) continue;
    for (const [key, values] of Object.entries(event.detail.dropped)) {
      if (relaxed.some((entry) => entry.key === key)) continue;
      relaxed.push({ key, values: [...(typeof values === "string" ? [values] : values)] });
    }
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
      ...(routingEvent !== undefined
        ? {
            routing: {
              ...routingEvent.detail,
              ...(relaxed.length > 0 ? { relaxed } : {}),
            },
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
 * with the caller's structured warning. Owner module for the helper the
 * citations derivation shares.
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
