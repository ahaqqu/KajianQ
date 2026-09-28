import * as v from "valibot";

/**
 * The field schemas a trace event is built from — the cost record, the stage
 * vocabulary, and a retrieval chunk ref. Split from `trace.ts` for the
 * 300-line agentic cap so the event vocabulary can import them without a cycle
 * (an event module that imported `trace.ts` back would be reading schemas
 * before they are initialized). Nothing here changed shape; the public surface
 * still arrives through `trace.ts` and the package barrel.
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
 * the two channel ranks plus the fused score so the Trace panel can show
 * retrieval provenance per chunk.
 */
export const ChunkRefSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  score: v.optional(v.number()),
  rankDense: v.optional(v.number()),
  rankSparse: v.optional(v.number()),
  /** Why this chunk is in the set: an opaque caller label (ADR-0045).
   * Absent = the fused tracks produced it, so older traces stay readable. */
  origin: v.optional(v.pipe(v.string(), v.minLength(1))),
});

/** The persisted trace's retrieval ref shape (thermo-review B3: the one owner). */
export type ChunkRef = v.InferOutput<typeof ChunkRefSchema>;
