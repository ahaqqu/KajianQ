import { Cause, Effect, Option, Stream } from "effect";
import { runPipeline, type PipelineStages, type RunOptions } from "./run";
import type { ProviderError } from "./provider";
import type { Answer, DefaultFilters, Query } from "./pipeline";
import type { RunConfig } from "./context";

/**
 * Promise-level interop for the HTTP edge (ADR-0027 decision 3: handlers
 * bridge via `Effect.runPromise`; Appendix A amendment: `apps/api` keeps no
 * direct `effect` dependency, so the bridge lives here and the API imports
 * these functions instead).
 */

/**
 * Run the five-stage pipeline, bridging to a promise. The promise rejects
 * with the typed `StageError` itself (unwrapped from the fiber failure) so
 * handlers can `instanceof`-check it for HTTP status mapping.
 */
export async function runPipelinePromise<TFilters extends Record<string, unknown> = DefaultFilters>(
  stages: PipelineStages<TFilters>,
  query: Query<TFilters>,
  config: RunConfig<TFilters> = {},
  options: RunOptions = {},
): Promise<Answer> {
  const exit = await Effect.runPromiseExit(runPipeline(stages, query, config, options));
  if (exit._tag === "Success") return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;
  throw Cause.squash(exit.cause);
}

/**
 * Bridge a provider delta `Stream` (e.g. `StreamHandle.deltas`) into a web
 * `ReadableStream` for the HTTP edge. A failing stream errors the web stream,
 * and a client disconnect (reader cancellation) interrupts the running fiber,
 * propagating into the provider fetch (ADR-0027 need 4).
 */
export function engineStreamToWeb(stream: Stream.Stream<string, ProviderError>): ReadableStream<Uint8Array> {
  return Stream.toReadableStream(Stream.encodeText(stream));
}

export { StageError } from "./errors";
export { ProviderError } from "./provider";
