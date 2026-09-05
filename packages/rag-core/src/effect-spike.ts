import { parseTrace } from "@app/contracts";
import { Context, Data, Effect, Layer, Schedule, Stream } from "effect";

/**
 * ADR-0027 §2 go/no-go spike (Workers gate). One program exercising the four
 * needs the ADR adopts Effect for, under the repo's strict tsconfig and the
 * Cloudflare Workers bundler:
 *
 * 1. typed error channel — `SpikeError` travels in `E`, not via throw
 * 2. retry policy — `Effect.retry` with a per-kind `Schedule` (backoff)
 * 3. lifecycle — a `Context.Tag` service provided through a `Layer`
 * 4. streaming — a `Stream` built from a `ReadableStream`
 *
 * plus the interop point the ADR fixes: a valibot contract parse
 * (`parseTrace`) inside `Effect.try`. Kept as a permanent, tested artifact of
 * the spike; deleted only if the gate fails and the ADR is revised.
 */

/** The spike's typed failure: only `rate_limited` attempts are retryable. */
export class SpikeError extends Data.TaggedError("SpikeError")<{
  readonly kind: "transport" | "rate_limited";
  readonly message: string;
}> {}

/** ADR-0021 `RunContext.now` responsibility, mapped to a `Context.Tag`. */
export class SpikeClock extends Context.Tag("app/spike/SpikeClock")<SpikeClock, {
  readonly now: () => number;
}>() {}

export const spikeClockLayer: Layer.Layer<SpikeClock> = Layer.succeed(SpikeClock, {
  now: () => Date.now(),
});

/**
 * A call that fails `failures` times with `rate_limited` before succeeding —
 * the stand-in for a Provider candidate behind a retry schedule.
 */
export const flakyCall = (
  state: { attempts: number },
  failures: number,
): Effect.Effect<string, SpikeError> =>
  Effect.sync(() => {
    state.attempts += 1;
    return state.attempts;
  }).pipe(
    Effect.flatMap((attempt) =>
      attempt <= failures
        ? Effect.fail(new SpikeError({ kind: "rate_limited", message: `attempt ${attempt}` }))
        : Effect.succeed(`ok on attempt ${attempt}`),
    ),
  );

/** Per-kind schedule: exponential backoff capped at 3 retries, retrying every error. */
export const retrySchedule = Schedule.exponential("10 millis").pipe(
  Schedule.compose(Schedule.recurs(3)),
);

/** A ReadableStream of text deltas, as the provider adapter would hand over. */
export const deltaReadableStream = (deltas: readonly string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const delta of deltas) controller.enqueue(encoder.encode(delta));
      controller.close();
    },
  });

/** Stream the deltas, converting the raw stream failure into `SpikeError`. */
export const deltaStream = (deltas: readonly string[]): Stream.Stream<string, SpikeError> =>
  Stream.decodeText(
    Stream.fromReadableStream({
      evaluate: () => deltaReadableStream(deltas),
      onError: (cause): SpikeError =>
        new SpikeError({ kind: "transport", message: `stream failed: ${String(cause)}` }),
    }),
  );

/** Parse a persisted trace through the valibot contract inside `Effect.try`. */
export const parseTraceEffect = (raw: {
  id: string;
  createdAt: number;
  events: readonly never[];
}): Effect.Effect<ReturnType<typeof parseTrace>, SpikeError> =>
  Effect.try({
    try: () => parseTrace(raw),
    catch: (cause): SpikeError =>
      new SpikeError({ kind: "transport", message: `trace contract rejected: ${String(cause)}` }),
  });

/**
 * The full spike program: retry a flaky call under the tagged clock, collect
 * a delta stream, and parse a trace contract — one `Effect.gen` pipeline.
 */
export const spikeProgram = (failures: number): Effect.Effect<
  { answer: string; attempts: number; deltas: readonly string[]; traceId: string },
  SpikeError,
  SpikeClock
> =>
  Effect.gen(function* () {
    const clock = yield* SpikeClock;
    const state = { attempts: 0 };
    const answer = yield* Effect.retry(flakyCall(state, failures), retrySchedule);
    const deltas = yield* Stream.runCollect(deltaStream(["hello", " ", "world"]));
    const trace = yield* parseTraceEffect({
      id: `spike-${clock.now()}`,
      createdAt: clock.now(),
      events: [],
    });
    return { answer, attempts: state.attempts, deltas: Array.from(deltas), traceId: trace.id };
  });
