import { Context } from "effect";
import type { Stage, TraceEvent } from "@app/contracts";

/**
 * Caller-chosen filter dimensions, passed through untouched. The engine is
 * generic over the filter shape so a domain pack can type its own dimensions
 * (e.g. `Query<KajianQFilters>`) instead of erasing them into an open string
 * map — the Retriever then gets typed filter access, not string re-casts.
 */
export type DefaultFilters = Record<string, string | readonly string[]>;

/**
 * Per-run configuration, threaded into every stage through the RunContext
 * service. Model ids are opaque strings resolved from `model_configs` at
 * wiring time — the engine never names a vendor or model (ADR-0009).
 *
 * ADR-0027 maps the RunContext's responsibilities to a `Context.Tag` service:
 * the per-run config, the clock, and the trace sink are required through the
 * `RunContext` Tag in the stages' `R` channel, and per-run disposal moved to
 * Effect's `Scope` (the runner opens one per run).
 */
export type RunConfig<TFilters extends Record<string, unknown>> = {
  /** Filter dimensions to merge into the query when the caller sets none. */
  filters?: TFilters;
  /** Per-stage model ids (opaque). */
  models?: Partial<Record<Stage, string>>;
};

/**
 * The service behind the `RunContext` Tag: per-run config, the clock, and the
 * trace sink — the single collection point for stage-emitted events
 * (ADR-0007). Config is typed with the open filter record so every
 * `RunConfig<TFilters>` provides it; a stage needing its own filter typing
 * reads filters off the `Query`/`RoutedQuery` it receives, which stay generic.
 */
export interface RunContextService {
  readonly config: RunConfig<Record<string, unknown>>;
  /** Monotonic timestamp source; stamp `at` on events you record. */
  now(): number;
  /** Append a typed event to the run's trace — the single collection point. */
  record(event: TraceEvent): void;
}

/**
 * The run's handle as an Effect service (ADR-0027): stage implementations do
 * `const run = yield* RunContext` to read config, stamp timestamps, and
 * record trace events; the runner is the only provider.
 */
export class RunContext extends Context.Tag("app/RunContext")<RunContext, RunContextService>() {}
