import * as v from "valibot";

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
 * Every recordable pipeline occurrence. Retrievals, LLM calls, and
 * refusals/suppressions are all events so "we said nothing confidently" stays
 * as auditable as an answered question (ADR-0007 amendment).
 */
export const TraceEventSchema = v.object({
  stage: StageSchema,
  /** e.g. "intent", "subquery", "retrieval", "llm_call", "refusal". */
  kind: v.pipe(v.string(), v.minLength(1)),
  /** Stage-specific structured detail, validated by the producing stage. */
  detail: v.optional(v.record(v.string(), v.unknown())),
  /** Present iff this event made one or more LLM/embedding calls. */
  cost: v.optional(CostRecordSchema),
  /** Set on refusal/suppression events; never silently swallow. */
  reason: v.optional(v.pipe(v.string(), v.minLength(1))),
  at: v.pipe(v.number(), v.integer()),
});

export type TraceEvent = v.InferOutput<typeof TraceEventSchema>;

/**
 * The per-answer record of how it was built. The PWA renders this shape; it
 * never reconstructs "how the answer was built" ad hoc. Invariant: a trace's
 * total cost equals the sum of its events' LLM costs — `totalCost` is derived
 * by the persister, so it cannot drift from the events.
 */
export const TraceSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  createdAt: v.pipe(v.number(), v.integer()),
  events: v.array(TraceEventSchema),
});

export type Trace = v.InferOutput<typeof TraceSchema>;

/** Sum of the trace's recorded per-event LLM costs, in micro-USD. */
export function totalCostMicroUsd(trace: Trace): number {
  return trace.events.reduce((sum, e) => sum + (e.cost?.costMicroUsd ?? 0), 0);
}
