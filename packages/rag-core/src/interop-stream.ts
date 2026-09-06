import { Effect, Stream } from "effect";
import { ProviderError, type StreamHandle } from "./provider";
import type { CostRecord } from "@app/contracts";

/**
 * Bridge a provider `StreamHandle` into a web `ReadableStream` for the HTTP
 * edge, owning the call's cost settlement (traceability guardrail, rule 4):
 * the caller cannot drop the cost record because the bridge — not the caller
 * — resolves it and hands every settled CostRecord to `onCost`:
 *
 * - completion → the handle's resolved `cost()` (metered or estimated);
 * - mid-flight failure or client disconnect (reader cancel interrupts the
 *   source fiber, whose scope finalizer aborts the provider fetch and
 *   settles the deferred cost deterministically) → the failed attempts'
 *   estimated spend from the `ProviderError`'s `attemptCosts` (a
 *   vendor-reaching attempt may never vanish from the cost trail).
 *
 * A failing stream errors the web stream after settlement. The settlement
 * finalizer unwinds after the deltas stream's own scope finalizer (LIFO —
 * it is registered first), mirroring the deterministic deferred-cost
 * settlement of the chat adapter's `chat-stream.ts`.
 */
export function engineStreamToWeb(
  handle: StreamHandle,
  onCost: (cost: CostRecord) => void,
): ReadableStream<Uint8Array> {
  const deltas: Stream.Stream<string, ProviderError> = Stream.unwrapScoped(
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        handle.cost().pipe(
          Effect.matchEffect({
            onSuccess: (cost) => Effect.sync(() => onCost(cost)),
            onFailure: (err) =>
              Effect.sync(() => {
                for (const cost of err.attemptCosts ?? []) onCost(cost);
              }),
          }),
        ),
      );
      return handle.deltas;
    }),
  );
  return Stream.toReadableStream(Stream.encodeText(deltas));
}
