import * as v from "valibot";

/**
 * The field schemas a trace event is built from — the cost record, the stage
 * vocabulary, and a retrieval chunk ref. Split from `trace.ts` to stay under
 * the agentic-limits line cap and so the event vocabulary can import them
 * without a cycle (an event module that imported `trace.ts` back would be
 * reading schemas before they are initialized). The public surface arrives
 * through `trace.ts` and the package barrel.
 */
/**
 * Cost attribution for a single LLM/embedding call. Model identity arrives as
 * an opaque string resolved from `model_configs` at wiring time — contracts
 * never name a vendor or model (ADR-0009).
 */
export const CostRecordSchema = v.object({
  modelId: v.pipe(v.string(), v.minLength(1)),
  tokensIn: v.pipe(v.number(), v.integer(), v.minValue(0)),
  tokensOut: v.pipe(v.number(), v.integer(), v.minValue(0)),
  latencyMs: v.pipe(v.number(), v.minValue(0)),
  /** Computed monetary cost in micro-USD to keep integer arithmetic exact. */
  costMicroUsd: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * True when tokens were estimated (e.g. a vendor that reports no streamed
   * usage) rather than metered — a trace must never present an estimate as
   * metered (ADR-0022). Optional so pre-existing records stay readable;
   * absent means metered.
   */
  estimated: v.optional(v.boolean()),
});

export type CostRecord = v.InferOutput<typeof CostRecordSchema>;

/**
 * Pipeline stages of the DARS engine (ADR-0005). Generic on purpose: domain
 * specifics (metadata filters, labels, prompt templates) arrive as typed event
 * payloads, never as engine-named concepts.
 */
export const StageSchema = v.picklist([
  "router",
  "retriever",
  "assembler",
  "generator",
  "reviewer",
  "ingest",
  "eval",
]);

export type Stage = v.InferOutput<typeof StageSchema>;

/**
 * A retrieved-chunk reference inside a `retrieval` event (ADR-0007). Carries
 * the chunk's dense rank plus the fused score so the Trace panel can show
 * retrieval provenance per chunk.
 */
export const ChunkRefSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  score: v.optional(v.number()),
  rankDense: v.optional(v.number()),
  /** A sparse-rank slot; no producer sets it. */
  rankSparse: v.optional(v.number()),
  /**
   * The reranker's score for this chunk when a rerank pass ran and applied —
   * 0..1, the decision model's per-candidate probability. Recorded BESIDE
   * `score` (the fused score) rather than replacing it, so a trace reader can
   * compare the two and tune the rerank from the trace alone; absent means no
   * rerank reordered this chunk.
   */
  rerankScore: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  /** Why this chunk is in the set: an opaque caller label. Absent = no rule
   * labelled it, which is the fused tracks' ordinary shape, so older traces stay
   * readable. A label can name a path that added the chunk (ADR-0045) or a rule
   * that promoted a fused row and marked its provenance (ADR-0062). */
  origin: v.optional(v.pipe(v.string(), v.minLength(1))),
});

/** The persisted trace's retrieval ref shape (the one owner). */
export type ChunkRef = v.InferOutput<typeof ChunkRefSchema>;

/**
 * The most chunk ids one search's trace record can carry. It is the retriever's
 * default per-track search size, and therefore the whole list a serving search
 * returns: a store's `limit` bounds `hits`, and the writer records every row it
 * returned, so no row the search saw is absent from its record by truncation.
 * The schema refuses a longer list, so the bound is the contract's, not a
 * writer's convention; a search configured with a larger `limit` must move this
 * value with it (a longer list fails the parse) rather than truncate silently.
 */
export const SEARCH_HITS_TRACE_LIMIT = 10;

/** The most transmission rows the trace record carries per child. */
export const CHAIN_EVIDENCE_TRACE_LIMIT = 8;

/**
 * The most of the caller's own leading dense hits the caller-priority guarantee
 * may carry into the context, and the default the retriever applies. Small on
 * purpose: these are the caller's strongest rows, not a second fused block, and
 * every one of them is kept out of the rerank's reorder and leads its
 * presentation slot.
 *
 * It is a **ceiling**, not only a convention: a `caller_priority` record naming
 * more ids fails the parse, so a run configured with a larger bound must not
 * write one. The retriever's `callerPriorityK` knob therefore defaults to this
 * value and the composition root refuses a larger one as a typed config failure
 * — the trace never fails to parse on a value the config allowed through.
 */
export const CALLER_PRIORITY_K = 3;
