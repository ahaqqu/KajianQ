import { Data, Effect, type Scope } from "effect";
import type { Stage } from "@app/contracts";
import type { RunContext } from "./context";

/**
 * The stage-level failure that travels in a pipeline stage's `E` channel
 * (ADR-0027). `stage` names the stage that failed — `"pipeline"` marks a
 * runner-level failure (e.g. trace contract rejection) rather than a stage
 * one — and `cause` carries the underlying error, which may be a
 * `ProviderError` the caller can narrow on for HTTP status mapping.
 */
export class StageError extends Data.TaggedError("StageError")<{
  readonly stage: Stage | "pipeline";
  readonly cause: unknown;
}> {}

/**
 * Attach a stage's `R` requirement (the `RunContext` service plus the run's
 * `Scope`) to an effect — the seam-wide requirement set for stage methods.
 */
export type StageRequirements = RunContext | Scope.Scope;

/** Shape an implementation's failure into the stage's typed `E` channel. */
export const toStageError = <A, E>(
  stage: Stage,
  effect: Effect.Effect<A, E, StageRequirements>,
): Effect.Effect<A, StageError, StageRequirements> =>
  Effect.mapError(
    effect,
    (cause): StageError =>
      cause instanceof StageError ? cause : new StageError({ stage, cause }),
  );
