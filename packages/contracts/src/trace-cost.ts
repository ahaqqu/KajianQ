import * as v from "valibot";

/**
 * Cost attribution for a single LLM/embedding call. Model identity arrives as
 * an opaque string resolved from `model_configs` at wiring time — contracts
 * never name a vendor or model (ADR-0009).
 *
 * It lives in its own module so a trace event variant can carry the contract's
 * one cost shape without importing `trace.ts` back (which composes the event
 * union and is at the agentic 300-line cap); `trace.ts` re-exports both names
 * unchanged, so no importer's path moves.
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
