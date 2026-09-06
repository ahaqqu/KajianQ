import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Scope,
  Stream,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect, it } from "vitest";
import {
  EffectSpikeError,
  SpikeResource,
  flakyCall,
  parseTraceEffect,
  retrySchedule,
  spikeClockLayer,
  spikeProgram,
  spikeResourceLayer,
} from "./effect-spike";

/** ADR-0027 §2 spike: the program runs under `Effect.runPromise` (vitest + bun). */

/** Extract the first typed failure from a failed exit. */
const failureOf = <E>(exit: Exit.Exit<unknown, E>): Option.Option<E> =>
  exit._tag === "Failure" ? Cause.failureOption(exit.cause) : Option.none<E>();

describe("effect spike", () => {
  it("retries a rate_limited failure with backoff until success", async () => {
    // Run under the TestClock: the 10/20 ms backoff sleeps complete the
    // moment the clock is adjusted — the testability pattern the migration
    // relies on. Fork + adjust + join must live in one TestContext program.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(flakyCall(2));
        for (let i = 0; i < 4; i++) yield* TestClock.adjust("1 second");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
    expect(result.answer).toBe("ok on attempt 3");
    expect(result.attempts).toBe(3);
  });

  it("gives up after the schedule exhausts and fails with the typed error", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.exit(flakyCall(10)));
        for (let i = 0; i < 5; i++) yield* TestClock.adjust("1 second");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
    const failure = failureOf(exit);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) {
      expect(failure.value).toBeInstanceOf(EffectSpikeError);
      expect(failure.value.kind).toBe("rate_limited");
    }
    expect(attemptsFrom(exit)).toBe(4); // 1 initial + 3 retries
  });

  it("does not retry a transport failure — exits after 1 attempt", async () => {
    const transportCall: Effect.Effect<string, EffectSpikeError> = Effect.fail(
      new EffectSpikeError({ kind: "transport", message: "connection reset" }),
    );
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.retry(transportCall, { schedule: retrySchedule }),
        TestContext.TestContext,
      ),
    );
    const failure = failureOf(exit);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) expect(failure.value.kind).toBe("transport");
  });

  it("streams deltas from a ReadableStream, uses the scoped resource, and parses the trace contract", async () => {
    const result = await Effect.runPromise(
      spikeProgram(1).pipe(Effect.provide(spikeClockLayer), Effect.provide(spikeResourceLayer)),
    );
    expect(result.answer).toBe("ok on attempt 2");
    expect(result.attempts).toBe(2);
    expect(result.deltas).toEqual(["hello", " ", "world"]);
    expect(result.traceId).toMatch(/^spike-\d+$/);
    // Observed before the program's scope closed, so not yet released.
    expect(result.resourceUsed).toBe(false);
  });

  it("releases the scoped resource when the layer's scope closes", async () => {
    // Build the layer inside an explicit `Scope.make`/`Scope.close` so the
    // release flag can be observed before and after close (`Layer.build`).
    const { released } = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const context = yield* Layer.build(spikeResourceLayer).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.orDie,
        );
        const resource = Context.get(context, SpikeResource);
        yield* resource.use;
        expect(yield* resource.released).toBe(false); // still open
        yield* Scope.close(scope, Exit.succeed(void 0 as void));
        return { released: yield* resource.released };
      }),
    );
    expect(released).toBe(true);
  });

  it("propagates the typed stream error mapped from the raw source", async () => {
    // A source ReadableStream whose `pull` errors: the failure travels through
    // `Stream.fromReadableStream`'s `onError`, not around it.
    let pulls = 0;
    const failingSource = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.error(new Error("underlying read failure"));
      },
    });
    const stream = Stream.decodeText(
      Stream.fromReadableStream({
        evaluate: () => failingSource,
        onError: (cause): EffectSpikeError =>
          new EffectSpikeError({
            kind: "transport",
            message: `stream failed: ${String(cause)}`,
          }),
      }),
    );
    const exit = await Effect.runPromiseExit(Stream.runCollect(stream));
    const failure = failureOf(exit);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) {
      expect(failure.value).toBeInstanceOf(EffectSpikeError);
      expect(failure.value.kind).toBe("transport");
      expect(failure.value.message).toContain("stream failed");
    }
    expect(pulls).toBe(1);
  });

  it("interrupts the stream consumption, cancelling the source ReadableStream", async () => {
    let cancelRan = false;
    const heldOpen = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Enqueue one delta, then keep the stream open (the pull promise never
        // resolves, so the reader.read() stays pending and the fiber blocks).
        controller.enqueue(new TextEncoder().encode("partial "));
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelRan = true;
      },
    });
    const stream = Stream.decodeText(
      Stream.fromReadableStream({
        evaluate: () => heldOpen,
        onError: (cause): EffectSpikeError =>
          new EffectSpikeError({ kind: "transport", message: `stream failed: ${String(cause)}` }),
      }),
    );
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Stream.runCollect(stream));
        // Let the fork start consuming before interrupting.
        yield* Effect.sleep("20 millis");
        // Fiber.interrupt must be run as an Effect, not passed as a bare value.
        return yield* Fiber.interrupt(fiber);
      }),
    );
    expect(Exit.isInterrupted(exit)).toBe(true);
    expect(cancelRan).toBe(true);
  });

  it("rejects a malformed trace contract through the Effect.try interop", async () => {
    const malformed = {
      id: "spike",
      createdAt: 1,
      events: [
        // Deliberately malformed: unknown `kind` must fail the contract.
        { stage: "router", kind: "nonexistent", detail: {} },
      ],
    };
    const exit = await Effect.runPromiseExit(parseTraceEffect(malformed));
    const failure = failureOf(exit);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) {
      expect(failure.value).toBeInstanceOf(EffectSpikeError);
      expect(failure.value.kind).toBe("contract");
      expect(failure.value.message.startsWith("trace contract rejected")).toBe(true);
    }
  });
});

// -- helpers ----------------------------------------------------------------

const attemptsFrom = (exit: Exit.Exit<unknown, EffectSpikeError>): number => {
  const failure = failureOf(exit);
  if (Option.isSome(failure)) {
    const match = /attempt (\d+)/.exec(failure.value.message);
    if (match) return Number(match[1]);
  }
  return -1;
};
