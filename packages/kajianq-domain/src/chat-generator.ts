import { Effect, Stream } from "effect";
import type { CostRecord } from "@app/contracts";
import {
  RunContext,
  toStageError,
  type AssembledContext,
  type Draft,
  type Generator,
} from "@app/rag-core";
import type { KajianQFilters } from "./filters";
import { chatSystemPrompt, chatUserPrompt, type ChatLanguage } from "./chat-prompts";

/**
 * KajianQGenerator — stage 6 (spec §3.3): the quality-tier generator with the
 * strict grounding prompt, streaming through the Provider seam. The call's
 * CostRecord is recorded to the run's trace sink (ADR-0021).
 *
 * Streaming contract (ticket #10): the generator calls `Provider.stream`, so
 * deltas arrive from the vendor as they are produced rather than after the
 * whole answer is buffered. The draft the stage returns is still the *full*
 * text — the reviewer must validate the complete answer before any of it
 * reaches the user (the citation gate cannot judge a half-answer). `onDelta`
 * is the observation hook: the HTTP edge forwards deltas to the client, and
 * the run's trace records the call's cost once the stream settles.
 *
 * The hook is optional and best-effort: a consumer that is not streaming (the
 * eval harness's non-streamed consume path, a unit test) omits it and the
 * stage behaves exactly like `generate`.
 */

/** The streamed-generation seam: `Provider.stream` narrowed to what we need. */
export type GeneratorProvider = {
  generate(spec: {
    turns: readonly { role: string; content: string }[];
  }): Effect.Effect<{ text: string; cost: CostRecord }, unknown>;
  /**
   * Streamed generation. Optional so a non-streaming test double (and any
   * Provider implementation predating this ticket) still satisfies the seam:
   * the generator falls back to `generate` when `stream` is absent.
   */
  stream?(spec: {
    turns: readonly { role: string; content: string }[];
  }): Effect.Effect<StreamHandleLike, unknown>;
};

/** The subset of the engine's `StreamHandle` this stage consumes. */
export type StreamHandleLike = {
  deltas: Stream.Stream<string, unknown>;
  cost: () => Effect.Effect<CostRecord, unknown>;
};

export type KajianQGeneratorDeps = {
  provider: GeneratorProvider;
  language: ChatLanguage;
  /**
   * Observation hook for streamed deltas. Called as text arrives; the full
   * text is still returned as the draft (the reviewer gates the whole
   * answer, and the route persists the final text — not the deltas).
   */
  onDelta?: (delta: string) => void;
};

export function createKajianQGenerator(deps: KajianQGeneratorDeps): Generator<KajianQFilters> {
  return {
    generate: (context: AssembledContext<KajianQFilters>) =>
      toStageError(
        "generator",
        Effect.gen(function* () {
          const run = yield* RunContext;
          const turns = [
            { role: "system", content: chatSystemPrompt(deps.language) },
            {
              role: "user",
              content: chatUserPrompt(
                context.query.intent,
                context.turns.map((t) => t.content).join("\n"),
              ),
            },
          ];
          // Bind the provider's own method before narrowing it. `Provider`
          // methods are class members on the fallback chain, so extracting
          // `stream` into a variable detaches `this` — and the chain's first
          // act is `this.eligibleEffectFor(spec)`, which then dies with
          // "Cannot read properties of undefined". Narrowing here (rather than
          // a `!` inside the stage) still keeps the invariant in the type.
          const provider = deps.provider;
          const stream = provider.stream?.bind(provider);
          const streamed =
            stream !== undefined
              ? yield* streamDraft(deps, stream, turns)
              : yield* generateDraft(deps, turns);
          run.record({
            stage: "generator",
            kind: "llm_call",
            detail: { purpose: "generate" },
            cost: streamed.cost,
            at: run.now(),
          });
          const draft: Draft = { text: streamed.text };
          return draft;
        }),
      ),
  };
}

/** The stage's typed failure wrapper: one place, not three inline wraps. */
const mapCause = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, { cause: unknown }> =>
  Effect.mapError(effect, (cause: unknown) => ({ cause }));

/**
 * The non-streamed path: one `generate` call. Used when the provider exposes
 * no `stream` (a test double, a model whose capabilities omit streaming).
 */
function generateDraft(
  deps: KajianQGeneratorDeps,
  turns: readonly { role: string; content: string }[],
): Effect.Effect<{ text: string; cost: CostRecord }, { cause: unknown }> {
  return mapCause(
    deps.provider
      .generate({ turns })
      .pipe(Effect.map((reply) => ({ text: reply.text, cost: reply.cost }))),
  );
}

/**
 * The streamed path: collect deltas, forwarding each to `onDelta`, and settle
 * the call's cost from the handle. The handle's `cost()` is awaited after the
 * stream completes so the trace carries the metered (or estimated) record —
 * never a dropped cost (traceability rule 4).
 *
 * A mid-flight failure propagates as the stage's typed failure; the failed
 * attempts' estimated spend rides the error's `attemptCosts` and is recorded
 * by the runner (ADR-0027 C2), so a cut stream still shows in the cost trail.
 *
 * `stream` is non-optional here (thermo-review B5): the caller narrows the
 * provider's optional method once, so the "stream exists" invariant is held
 * by the parameter type rather than a `!` assertion.
 */
function streamDraft(
  deps: KajianQGeneratorDeps,
  stream: NonNullable<GeneratorProvider["stream"]>,
  turns: readonly { role: string; content: string }[],
): Effect.Effect<{ text: string; cost: CostRecord }, { cause: unknown }> {
  return Effect.gen(function* () {
    const handle = yield* mapCause(stream({ turns }));
    let text = "";
    yield* mapCause(
      Stream.runForEach(handle.deltas, (delta) =>
        Effect.sync(() => {
          text += delta;
          deps.onDelta?.(delta);
        }),
      ),
    );
    const cost = yield* mapCause(handle.cost());
    return { text, cost };
  });
}
