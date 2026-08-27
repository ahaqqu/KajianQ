import type { Stage, TraceEvent } from "@app/contracts";

/** A per-run or per-stage cleanup; runs LIFO and may be async. */
export type Disposer = () => void | Promise<void>;

/**
 * Per-run configuration, threaded into every stage through the RunContext.
 * Model ids are opaque strings resolved from `model_configs` at wiring time —
 * the engine never names a vendor or model (ADR-0009). This is the hand-rolled
 * "isolate by config" knob: a per-request config object rather than a plugin
 * context scope (ADR-0021).
 */
export type RunConfig<TFilters extends Record<string, unknown>> = {
  /** Filter dimensions to merge into the query when the caller sets none. */
  filters?: TFilters;
  /** Per-stage model ids (opaque). */
  models?: Partial<Record<Stage, string>>;
};

/**
 * The run's handle: config, the trace sink, and the disposal scope. The runner
 * creates one per run and passes it to every stage so the trace has a single
 * collection point (ADR-0007) and per-run resources tear down deterministically
 * (ADR-0021).
 */
export interface RunContext<TFilters extends Record<string, unknown>> {
  readonly config: RunConfig<TFilters>;
  /** Monotonic timestamp source; stamp `at` on events you record. */
  now(): number;
  /** Append a typed event to the run's trace — the single collection point. */
  record(event: TraceEvent): void;
  /** Register a per-run resource to dispose (LIFO) when the run completes. */
  defer(disposer: Disposer): void;
}
