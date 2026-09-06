import { Cause, Data, Effect, Option } from "effect";
import { runPipeline, type PipelineStages, type RunConfig, type RunOptions } from "./run";
import { StageError } from "./errors";
import { ProviderError, type ProviderErrorKind } from "./provider";
import { type Answer, type DefaultFilters, type Query } from "./pipeline";

export { StageError, ProviderError, type ProviderErrorKind };

/**
 * Promise-level interop for the HTTP edge (ADR-0027 decision 3: handlers
 * bridge via `Effect.runPromise`; Appendix A amendment: `apps/api` keeps no
 * direct `effect` dependency, so the bridge lives here and the API imports
 * these functions instead).
 */

/**
 * The typed failure of a client-aborted run: the caller's `AbortSignal` fired
 * and the bridge interrupted the pipeline fiber (ADR-0027 need 3). The HTTP
 * edge treats it as a quiet disconnect — never a 5xx, never a Sentry
 * exception — because a disconnect is an expected condition, not a defect.
 */
export class PipelineAbortedError extends Data.TaggedError("PipelineAbortedError")<{
  readonly signal: AbortSignal;
}> {}

/** Bridge-level run knobs: the runner's `RunOptions` plus cancellation. */
export type BridgeOptions = RunOptions & {
  /**
   * Abort signal (typically the HTTP request's). When it fires, the run's
   * fiber is interrupted — scope finalizers unwind, in-flight work stops at
   * the next interruptible boundary — and the promise rejects with
   * `PipelineAbortedError`. A signal that is already aborted rejects before
   * the pipeline starts.
   */
  signal?: AbortSignal;
};

/**
 * Run the five-stage pipeline, bridging to a promise. The promise rejects
 * with the typed `StageError` itself (unwrapped from the fiber failure) so
 * handlers can `instanceof`-check it for HTTP status mapping, or with
 * `PipelineAbortedError` when the signal aborts.
 *
 * A failed run's collected trace events are not discarded: pass
 * `onFailedTrace` (see `RunOptions`) to receive the failed run's parsed
 * Trace — including the failed vendor attempts' costs the runner recorded —
 * so failures stay visible to the trace store (traceability guardrail).
 */
export async function runPipelinePromise<TFilters extends Record<string, unknown> = DefaultFilters>(
  stages: PipelineStages<TFilters>,
  query: Query<TFilters>,
  config: RunConfig<TFilters> = {},
  options: BridgeOptions = {},
): Promise<Answer> {
  const program = options.signal
    ? raceSignal(runPipeline(stages, query, config, options), options.signal)
    : runPipeline(stages, query, config, options);
  const exit = await Effect.runPromiseExit(program);
  if (exit._tag === "Success") return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;
  throw Cause.squash(exit.cause);
}

/**
 * Race the program against the signal: on abort, `raceFirst` interrupts the
 * program's fiber (finalizers unwind, in-flight work stops) and the abort
 * side fails with the typed `PipelineAbortedError`. The listener is removed
 * when either side settles.
 */
function raceSignal<A, E>(
  effect: Effect.Effect<A, E>,
  signal: AbortSignal,
): Effect.Effect<A, E | PipelineAbortedError> {
  return Effect.suspend(() => {
    if (signal.aborted) return Effect.fail(new PipelineAbortedError({ signal }));
    return Effect.raceFirst(
      effect,
      Effect.async<never, PipelineAbortedError>((resume) => {
        const onAbort = () => resume(Effect.fail(new PipelineAbortedError({ signal })));
        signal.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", onAbort));
      }),
    );
  });
}
