import { Cause, Effect, Exit, Option, Stream } from "effect";
import { ProviderError, type StreamHandle } from "@app/rag-core";
import type { CostRecord } from "@app/contracts";
import { computeCost, estimateTokens } from "./chat-cost";
import { readSseStream, type StreamOutcome, type StreamUsage } from "./sse-stream";

/**
 * The streaming half of the chat-completions adapter (ADR-0022, ADR-0027):
 * wraps a chat-completions SSE body into the seam's `StreamHandle` — a
 * lazily pulled `Stream` of deltas plus the call's deferred CostRecord. Split
 * from the adapter to keep each module under the agentic size limit.
 *
 * Cancellation is real, not cosmetic: the deltas `Stream` owns a scope whose
 * finalizer aborts the provider fetch (the request's AbortController) and
 * deterministically fails the deferred cost. A consumer that interrupts or
 * stops consuming early therefore cuts the wire, and `cost()` never pends
 * forever (client-cancel is ADR-0027's need 3).
 */

/**
 * Build the streamed call's CostRecord: metered where the vendor reported
 * streamed usage, otherwise estimated from the prompt tokens and the emitted
 * chars (~4 chars/token) — an estimate is never presented as metered
 * (ADR-0022). Latency is wall clock to the end of iteration, so a slow
 * consumer inflates it (deliberate; eager buffering rejected as complexity
 * for a Trace-only metric).
 */
function buildStreamCost(input: {
  modelId: string;
  price: { in: number; out: number };
  promptTokensInEstimate: number;
  startedAt: number;
}) {
  return (usage: StreamUsage | undefined, charCount: number): CostRecord => {
    const metered =
      typeof usage?.prompt_tokens === "number" && typeof usage?.completion_tokens === "number";
    const tokensIn = metered ? usage!.prompt_tokens! : input.promptTokensInEstimate;
    const tokensOut = metered ? usage!.completion_tokens! : estimateTokens(charCount);
    return computeCost(
      input.modelId,
      input.price,
      tokensIn,
      tokensOut,
      Date.now() - input.startedAt,
      !metered,
    );
  };
}

/**
 * Wrap a chat-completions SSE body into a `StreamHandle`. Deltas are pulled
 * lazily from the wire — each pull is interruptible, and the stream's scope
 * finalizer aborts the provider fetch and settles the deferred cost when the
 * consumer interrupts, stops early, or a pull fails. Where deltas were never
 * consumed, `cost()` drains the remainder internally (discarding text) so
 * the promise settles instead of deadlocking; a mid-flight wire failure
 * fails both the deltas stream and the cost effect with the same
 * `ProviderError`.
 */
export function streamHandle(input: {
  /** SSE body of the streaming response. */
  body: ReadableStream<Uint8Array>;
  /** Abort the underlying provider fetch (the request's AbortController). */
  abort: () => void;
  modelId: string;
  price: { in: number; out: number };
  /** Prompt-token estimate for the no-usage path (per-turn chars/4). */
  promptTokensInEstimate: number;
  startedAt: number;
}): StreamHandle {
  const buildCost = buildStreamCost(input);

  let costResolve: (cost: CostRecord) => void;
  let costReject: (err: unknown) => void;
  const costPromise = new Promise<CostRecord>((resolveCost, rejectCost) => {
    costResolve = resolveCost;
    costReject = rejectCost;
  });
  // Rejections are always observed by exactly one path (the awaiting cost()
  // effect or an exit settlement); this guard keeps an unobserved rejection
  // (e.g. a consumer that interrupts and never awaits cost) from surfacing
  // as an unhandled rejection while leaving the promise rejectable for real
  // awaiters.
  costPromise.catch(() => {});
  let settled = false;
  let deltasStarted = false;
  let iterator: AsyncGenerator<string, StreamOutcome> | undefined;

  const toProviderError = (cause: unknown): ProviderError =>
    cause instanceof ProviderError
      ? cause
      : new ProviderError({ kind: "transport", message: `stream failed: ${String(cause)}` });

  function start(): AsyncGenerator<string, StreamOutcome> {
    // One iterator shared by the deltas stream and cost()'s drain, so a
    // consumer arriving after a drain sees a completed stream, not a locked
    // body.
    if (!iterator) iterator = readSseStream(input.body);
    return iterator;
  }

  function settle(done: boolean, value?: StreamOutcome | Error): void {
    if (settled) return;
    settled = true;
    if (done && value && "usage" in value) {
      costResolve(buildCost(value.usage, value.charCount));
    } else if (value instanceof Error) {
      costReject(value);
    }
  }

  /** Settle the cost promise from a scope or drain exit: the error that
   * killed the stream fails cost; an interrupt (no failure value) fails it
   * deterministically instead of leaving it pending. Natural completion
   * settles in the pull loop, so a Success exit is a no-op here. */
  function settleFromExit(exit: Exit.Exit<unknown, unknown>): void {
    if (settled || exit._tag === "Success") return;
    const failure = Cause.failureOption(exit.cause);
    settle(
      false,
      Option.isSome(failure) && failure.value instanceof Error
        ? failure.value
        : new ProviderError({
            kind: "transport",
            message: `stream terminated before completion: ${String(Option.isSome(failure) ? failure.value : "interrupted")}`,
          }),
    );
  }

  const deltas: Stream.Stream<string, ProviderError> = Stream.unwrapScoped(
    Effect.gen(function* () {
      const it = start();
      deltasStarted = true;
      // On interrupt, early stop, or pull failure: cut the wire and settle
      // the deferred cost deterministically instead of leaving it pending.
      yield* Effect.addFinalizer((exit) =>
        Effect.sync(() => {
          if (!settled) input.abort();
          settleFromExit(exit);
        }),
      );
      return Stream.unfoldEffect(it, (gen) =>
        Effect.tryPromise({ try: () => gen.next(), catch: toProviderError }).pipe(
          Effect.flatMap((next) =>
            next.done
              ? Effect.sync(() => {
                  settle(true, next.value);
                  return Option.none<readonly [string, AsyncGenerator<string, StreamOutcome>]>();
                })
              : Effect.succeed(Option.some([next.value, gen] as const)),
          ),
        ),
      );
    }),
  );

  const cost = (): Effect.Effect<CostRecord, ProviderError> =>
    Effect.suspend(() => {
      if (settled || !deltasStarted) {
        if (!settled && !deltasStarted) {
          // Nobody consumes deltas — drain the remainder here (text
          // discarded) so the promise settles instead of deadlocking. When a
          // consumer is mid-iteration it owns the iterator; racing it would
          // steal its next delta, so cost() only awaits the promise it will
          // settle.
          deltasStarted = true;
          const it = start();
          return Effect.onExit(
            Effect.gen(function* () {
              while (true) {
                const next = yield* Effect.tryPromise({
                  try: () => it.next(),
                  catch: toProviderError,
                });
                if (next.done) {
                  settle(true, next.value);
                  break;
                }
              }
            }),
            (exit) =>
              Effect.sync(() => {
                // The drain itself failed or was interrupted: cut the wire
                // and settle the cost deterministically.
                if (!settled) input.abort();
                settleFromExit(exit);
              }),
          ).pipe(
            Effect.andThen(
              Effect.tryPromise({ try: () => costPromise, catch: toProviderError }),
            ),
          );
        }
        // Deltas were consumed but the stream is still mid-flight: the
        // consumer's scope finalizer owns the settlement; cost() only awaits
        // it.
        return Effect.tryPromise({ try: () => costPromise, catch: toProviderError });
      }
      return Effect.tryPromise({ try: () => costPromise, catch: toProviderError });
    });

  return { deltas, cost };
}