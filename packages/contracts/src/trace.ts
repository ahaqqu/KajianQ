import * as v from "valibot";
import { TraceEventSchema } from "./trace-events";

// Re-exported so the package's public trace surface is one import path however
// the 300-line agentic cap distributes the files: `index.ts`, the adapter, the
// web client and the eval harness all import from here exactly as before.
// Each name has exactly ONE owner module — the cost shape included, which
// lives in `./trace-primitives` and nowhere else (no second spelling of it is
// a valid layout).
export {
  ChunkRefSchema,
  CostRecordSchema,
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
 * traces stay readable as the contract evolves (ADR-0007 amendment).
 *
 * A new event *kind* is additive on the same terms and does NOT bump
 * `version`: a trace persisted before the kind shipped simply carries no
 * event of it, so the enumeration's growth cannot make an older trace
 * unreadable, and the version anchor covers `Trace`'s own fields rather than
 * the event union's size (every kind added since `version` was introduced —
 * `filter_relaxed`, `scope_expansion`, `decision`, and now `product_rules` —
 * shipped without a bump, and the runner does not write `version` at all).
 * What a reader MUST NOT do is read the absence of such an event as a
 * negative for a trace written before the kind existed; presence is the
 * signal, absence is ambiguous across the version boundary.
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
 * Validate and return a Trace, throwing on a malformed event. The pipeline
 * runner calls this once when assembling the final trace so a mis-shaped or
 * unknown-kind event fails the run instead of persisting silently (ADR-0007
 * amendment, #45).
 */
export function parseTrace(trace: unknown): Trace {
  return v.parse(TraceSchema, trace);
}
