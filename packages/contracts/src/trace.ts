import * as v from "valibot";
import { TraceEventSchema } from "./trace-events";
import { StageSchema } from "./trace-primitives";

// Re-exported so the package's public trace surface is one import path however
// the agentic size cap distributes the files: `index.ts`, the adapter, the web
// client and the eval harness import from here. Each name has exactly ONE owner
// module — the cost shape included, which lives in `./trace-primitives` and
// nowhere else (no second spelling of it is a valid layout).
export {
  CALLER_PRIORITY_K,
  ChunkRefSchema,
  CostRecordSchema,
  SEARCH_HITS_TRACE_LIMIT,
  StageSchema,
  type ChunkRef,
  type CostRecord,
  type Stage,
} from "./trace-primitives";
export { TraceEventSchema, type TraceEvent, type TraceEventKind } from "./trace-events";

/**
 * The per-answer record of how it was built. The PWA renders this shape; it
 * never reconstructs "how the answer was built" ad hoc. Invariant: a trace's
 * total cost equals the sum of its events' LLM costs — `totalCost` is derived
 * by the persister, so it cannot drift from the events.
 *
 * Forward-compatibility contract: `version` is the schema anchor. The Trace
 * shape may only ever *add optional* fields (version-bumped); it must never
 * add a required field or rename/remove an existing one without migrating
 * persisted traces. The RagStore reader uses `v.parse`, which tolerates
 * missing optional fields and strips unknown future keys, so older persisted
 * traces stay readable as the contract evolves (ADR-0007).
 *
 * A new event *kind* is additive on the same terms and does NOT bump
 * `version`: a trace persisted before the kind shipped simply carries no
 * event of it, so the enumeration's growth cannot make an older trace
 * unreadable, and the version anchor covers `Trace`'s own fields rather than
 * the event union's size. What a reader MUST NOT do is read the absence of
 * such an event as a negative for a trace written before the kind existed;
 * presence is the signal, absence is ambiguous across the version boundary
 * (the runner does not write `version` at all).
 */
export const TraceSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  /** Schema version, starting at 1. Older persisted traces read as unset. */
  version: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  createdAt: v.pipe(v.number(), v.integer()),
  events: v.array(TraceEventSchema),
});

export type Trace = v.InferOutput<typeof TraceSchema>;

/** Sum of the trace's recorded per-event LLM costs, in micro-USD. */
export function totalCostMicroUsd(trace: Trace): number {
  return trace.events.reduce((sum, e) => sum + (e.cost?.costMicroUsd ?? 0), 0);
}

/**
 * One answer's totals across **every** provider call its trace recorded — router,
 * embedding, generator, reviewer, decision screens, and the failed attempts before
 * a retry succeeded. The embedding call rides its own `llm_call` event
 * (`purpose: "embed"`), so it is summed here by the rule every other call is: no
 * provider call a trace records is missing from this total.
 *
 * `costMicroUsd` is `totalCostMicroUsd` — one arithmetic, two readers — so a total
 * shown beside the per-call list can never disagree with the run's cost invariant
 * ("a run's recorded cost equals the sum of its recorded calls", ADR-0007).
 * `latencyMs` sums the calls' own latencies: that is the provider time an answer
 * paid, not its wall-clock time (retrieval, assembly and queueing are not provider
 * calls). `estimated` is true when any call's tokens were estimated rather than
 * metered, so a reader is never shown an estimate as metered (ADR-0022).
 */
export const TraceTotalsSchema = v.object({
  tokensIn: v.pipe(v.number(), v.integer(), v.minValue(0)),
  tokensOut: v.pipe(v.number(), v.integer(), v.minValue(0)),
  latencyMs: v.pipe(v.number(), v.minValue(0)),
  costMicroUsd: v.pipe(v.number(), v.integer(), v.minValue(0)),
  estimated: v.boolean(),
});

export type TraceTotals = v.InferOutput<typeof TraceTotalsSchema>;

/**
 * One provider call as the trace recorded it, in trace order: the stage that made
 * it, the event's own `purpose` label where the event carries one (the embedding
 * call and the decision screens do), the model identity, and the call's metered
 * tokens, latency and cost. This is the list an operator reads when a message's
 * total looks wrong — every row is a call that actually ran.
 */
export const TraceProviderCallSchema = v.object({
  stage: StageSchema,
  purpose: v.optional(v.pipe(v.string(), v.minLength(1))),
  modelId: v.pipe(v.string(), v.minLength(1)),
  tokensIn: v.pipe(v.number(), v.integer(), v.minValue(0)),
  tokensOut: v.pipe(v.number(), v.integer(), v.minValue(0)),
  latencyMs: v.pipe(v.number(), v.minValue(0)),
  costMicroUsd: v.pipe(v.number(), v.integer(), v.minValue(0)),
  estimated: v.optional(v.boolean()),
});

export type TraceProviderCall = v.InferOutput<typeof TraceProviderCallSchema>;

/** An event's own `purpose` label, when its detail carries one (`embed`, the
 * decision screens). Read structurally: an event kind that carries no detail keeps
 * its place in the list rather than dropping the call. */
function purposeOf(detail: unknown): string | undefined {
  if (typeof detail !== "object" || detail === null) return undefined;
  const value = (detail as { purpose?: unknown }).purpose;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The trace's provider calls, in trace order — one row per recorded call. */
export function traceProviderCalls(trace: Trace): TraceProviderCall[] {
  const calls: TraceProviderCall[] = [];
  for (const event of trace.events) {
    const cost = event.cost;
    if (cost === undefined) continue;
    const purpose = purposeOf(event.detail);
    calls.push({
      stage: event.stage,
      ...(purpose !== undefined ? { purpose } : {}),
      modelId: cost.modelId,
      tokensIn: cost.tokensIn,
      tokensOut: cost.tokensOut,
      latencyMs: cost.latencyMs,
      costMicroUsd: cost.costMicroUsd,
      ...(cost.estimated !== undefined ? { estimated: cost.estimated } : {}),
    });
  }
  return calls;
}

/** One answer's totals over every recorded provider call — see `TraceTotalsSchema`. */
export function traceTotals(trace: Trace): TraceTotals {
  let tokensIn = 0;
  let tokensOut = 0;
  let latencyMs = 0;
  let estimated = false;
  for (const event of trace.events) {
    const cost = event.cost;
    if (cost === undefined) continue;
    tokensIn += cost.tokensIn;
    tokensOut += cost.tokensOut;
    latencyMs += cost.latencyMs;
    if (cost.estimated === true) estimated = true;
  }
  return { tokensIn, tokensOut, latencyMs, costMicroUsd: totalCostMicroUsd(trace), estimated };
}

/**
 * Validate and return a Trace, throwing on a malformed event. The pipeline
 * runner calls this once when assembling the final trace so a mis-shaped or
 * unknown-kind event fails the run instead of persisting silently (ADR-0007).
 */
export function parseTrace(trace: unknown): Trace {
  return v.parse(TraceSchema, trace);
}
