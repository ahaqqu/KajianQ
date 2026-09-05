import { Cause, Effect, Option, Schedule, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  SpikeError,
  deltaStream,
  flakyCall,
  parseTraceEffect,
  retrySchedule,
  spikeClockLayer,
  spikeProgram,
} from "./effect-spike";

/** ADR-0027 §2 spike: the program runs under `Effect.runPromise` (vitest + bun). */

describe("effect spike", () => {
  it("retries a rate_limited failure with backoff until success", async () => {
    const state = { attempts: 0 };
    const answer = await Effect.runPromise(
      Effect.retry(flakyCall(state, 2), { schedule: retrySchedule }),
    );
    expect(answer).toBe("ok on attempt 3");
    expect(state.attempts).toBe(3);
  });

  it("gives up after the schedule exhausts and fails with the typed error", async () => {
    const state = { attempts: 0 };
    const exit = await Effect.runPromiseExit(
      Effect.retry(flakyCall(state, 10), { schedule: retrySchedule }),
    );
    expect(exit._tag).toBe("Failure");
    expect(state.attempts).toBe(4); // 1 initial + 3 retries
  });

  it("streams deltas from a ReadableStream and parses the trace contract", async () => {
    const result = await Effect.runPromise(
      spikeProgram(1).pipe(Effect.provide(spikeClockLayer)),
    );
    expect(result.answer).toBe("ok on attempt 2");
    expect(result.attempts).toBe(2);
    expect(result.deltas).toEqual(["hello", " ", "world"]);
    expect(result.traceId).toMatch(/^spike-\d+$/);
  });

  it("propagates the typed stream error", async () => {
    const failing = deltaStream(["x"]).pipe(
      Stream.mapEffect(() => Effect.fail(new SpikeError({ kind: "transport", message: "x" }))),
    );
    const exit = await Effect.runPromiseExit(Stream.runCollect(failing));
    const failure = exit._tag === "Failure" ? Cause.failureOption(exit.cause) : Option.none<SpikeError>();
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) expect(failure.value.kind).toBe("transport");
  });

  it("rejects a malformed trace contract through the Effect.try interop", async () => {
    const exit = await Effect.runPromiseExit(
      parseTraceEffect({
        id: "",
        createdAt: -1,
        events: [{ stage: "router", kind: "nonexistent" } as never],
      }),
    );
    expect(exit._tag).toBe("Failure");
  });
});
