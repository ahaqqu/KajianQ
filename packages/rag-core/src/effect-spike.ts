import { parseTrace } from "@app/contracts";
import {
  Context,
  Data,
  Effect,
  Layer,
  Ref,
  Schedule,
  Stream,
} from "effect";

/**
 * ADR-0027 §2 go/no-go spike (Workers gate). One program exercising the four
 * needs the ADR adopts Effect for, under the repo's strict tsconfig and the
 * Cloudflare Workers bundler:
 *
 * 1. typed error channel — `EffectSpikeError` travels in `E`, not via throw
 * 2. retry policy — `Effect.retry` with a kind-selective `Schedule` (backoff)
 * 3. lifecycle — a `Context.Tag` service acquired/released through
 *    `Layer.scoped`
 * 4. streaming — a `Stream` built from a `ReadableStream` with
 *    interruption-capable consumption
 *
 * plus the interop point the ADR fixes: a valibot contract parse
 * (`parseTrace`) inside `Effect.try`. Kept as a permanent, tested artifact of
 * the spike; deleted only if a revisit trigger fires and the ADR is revised.
 */

/**
 * The spike's typed failure, bucketed by semantic kind: only `rate_limited`
 * is transient and retryable; `contract` is a valibot schema violation; the
 * other kinds are non-retryable I/O failures.
 */
export class EffectSpikeError extends Data.TaggedError("EffectSpikeError")<{
  readonly kind: "transport" | "rate_limited" | "contract";
  readonly message: string;
}> {}

/** ADR-0021 `RunContext.now` responsibility, mapped to a `Context.Tag`. */
export class SpikeClock extends Context.Tag("app/spike/SpikeClock")<SpikeClock, {
  readonly now: () => number;
}>() {}

/**
 * A lifecycle-managed resource: acquired when the layer builds, released when
 * the scope closes. The release signal is observable so tests can assert the
 * release actually ran (ADR-0027 decision 3, "Scope lifecycle").
 */
export class SpikeResource extends Context.Tag("app/spike/SpikeResource")<SpikeResource, {
  /** Increments the resource's usage count. */
  readonly use: Effect.Effect<void>;
  /** Observed `true` only after the scope released the resource. */
  readonly released: Effect.Effect<boolean>;
}>() {}

/** `Layer.scoped` acquire/release around a `Ref`-held release flag. */
export const spikeResourceLayer: Layer.Layer<SpikeResource> = Layer.scoped(
  SpikeResource,
  Effect.gen(function* () {
    const released = yield* Ref.make(false);
    const open = yield* Effect.acquireRelease(
      Ref.make(0),
      () => Ref.set(released, true),
    );
    return {
      use: Ref.updateAndGet(open, (n) => n + 1).pipe(Effect.asVoid),
      released: Ref.get(released),
    };
  }),
);

export const spikeClockLayer: Layer.Layer<SpikeClock> = Layer.succeed(SpikeClock, {
  now: () => Date.now(),
});

/**
 * A call that fails `failures` times with `rate_limited` before succeeding —
 * the stand-in for a Provider candidate behind a retry schedule. The attempt
 * count is returned in the result (a `Ref` inside the Effect), not tracked
 * through a caller-owned mutable object.
 */
export const flakyCall = (
  failures: number,
): Effect.Effect<{ answer: string; attempts: number }, EffectSpikeError> =>
  Ref.make(0).pipe(
    Effect.flatMap((attempts) =>
      Effect.retry(
        Ref.updateAndGet(attempts, (n) => n + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt <= failures
              ? Effect.fail(
                new EffectSpikeError({
                  kind: "rate_limited",
                  message: `attempt ${attempt}`,
                }),
              )
              : Effect.succeed(`ok on attempt ${attempt}`),
          ),
        ),
        { schedule: retrySchedule },
      ).pipe(Effect.flatMap((answer) => Effect.map(Ref.get(attempts), (attempts) => ({ answer, attempts })))),
    ),
  );

/**
 * Kind-selective retry schedule: exponential backoff capped at 3 retries,
 * continuing only while the failing error is retryable (`rate_limited`); any
 * other kind stops the schedule, so the failure surfaces after 1 attempt.
 */
export const retrySchedule = Schedule.exponential("10 millis").pipe(
  Schedule.whileInput((e: EffectSpikeError) => e.kind === "rate_limited"),
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

/** Stream the deltas, converting the raw stream failure into `EffectSpikeError`. */
export const deltaStream = (deltas: readonly string[]): Stream.Stream<string, EffectSpikeError> =>
  Stream.decodeText(
    Stream.fromReadableStream({
      evaluate: () => deltaReadableStream(deltas),
      onError: (cause): EffectSpikeError =>
        new EffectSpikeError({ kind: "transport", message: `stream failed: ${String(cause)}` }),
    }),
  );

/** Parse a persisted trace through the valibot contract inside `Effect.try`. */
export const parseTraceEffect = (
  raw: unknown,
): Effect.Effect<ReturnType<typeof parseTrace>, EffectSpikeError> =>
  Effect.try({
    try: () => parseTrace(raw),
    catch: (cause): EffectSpikeError =>
      new EffectSpikeError({ kind: "contract", message: `trace contract rejected: ${String(cause)}` }),
  });

/**
 * The full spike program: retry a flaky call under the tagged clock, collect
 * a delta stream, parse a trace contract, and touch the scoped resource —
 * one `Effect.gen` pipeline.
 */
export const spikeProgram = (failures: number): Effect.Effect<
  {
    answer: string;
    attempts: number;
    deltas: readonly string[];
    traceId: string;
    resourceUsed: boolean;
  },
  EffectSpikeError,
  SpikeClock | SpikeResource
> =>
  Effect.gen(function* () {
    const clock = yield* SpikeClock;
    const resource = yield* SpikeResource;
    yield* resource.use;
    const resourceUsed = yield* resource.released;
    const { answer, attempts } = yield* flakyCall(failures);
    const deltas = yield* Stream.runCollect(deltaStream(["hello", " ", "world"]));
    const trace = yield* parseTraceEffect({
      id: `spike-${clock.now()}`,
      createdAt: clock.now(),
      events: [],
    });
    return { answer, attempts, deltas: Array.from(deltas), traceId: trace.id, resourceUsed };
  });