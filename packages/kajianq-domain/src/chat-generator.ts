import { Effect, Stream } from "effect";
import {
  ProviderError,
  RunContext,
  toStageError,
  type AssembledContext,
  type CostRecord,
  type Draft,
  type Generator,
  type RunContextService,
} from "@app/rag-core";
import type { KajianQFilters } from "./filters";
import {
  addressedReread,
  chatSystemPrompt,
  chatUserPrompt,
  type ChatLanguage,
  type ChatTurn,
} from "./chat-prompts";
import { isRefusalOnly } from "./chat-refusal";

/** The answer stage's language, re-exported for the barrel that wires its stages. */
export type { ChatLanguage };

/**
 * How many more times the generator reads the same evidence before a pure
 * refusal is shipped. A refusal claims the evidence cannot answer; a single
 * sampled reading of a stochastic model is not enough to ship that claim, so a
 * pure refusal is reread and only a refusal that reproduces ships. A draft that
 * answers is never reread — a hybrid carrying the sentence at the tail of a
 * grounded partial answer included, because that draft has answered.
 *
 * Named, not inlined: it is the rule's whole value, and `chat-generator.test.ts`
 * pins both the bound and the two-reading behaviour.
 */
export const REFUSAL_REREAD_LIMIT = 1;

/**
 * KajianQGenerator — stage 6 (spec §3.3): the quality-tier generator with the
 * strict grounding prompt, streaming through the Provider seam. Every call's
 * CostRecord is recorded to the run's trace sink (ADR-0021).
 *
 * Streaming contract: the generator calls `Provider.stream`, so
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
 *
 * A pure refusal is reread on the same evidence. When that happens the refused
 * attempt's deltas precede the reread's, so a consumer replaying deltas must
 * replay only a prefix that reproduces the delivered text — and a reread that
 * fails mid-flight can leave a partial tail behind (the HTTP edge's chunking
 * fallback is exactly that guard).
 */

/** The streamed-generation seam: `Provider.stream` narrowed to what we need. */
export type GeneratorProvider = {
  generate(spec: {
    turns: readonly { role: string; content: string }[];
    /**
     * Required on the serving seam: the generator prompt carries the user's
     * question and its assembled context — personal data (ADR-0043
     * Consequences). Non-optional so a call site that drops it is a compile
     * error; the provider seam skips free-tier candidates when it is set.
     */
    personalData: true;
  }): Effect.Effect<{ text: string; cost: CostRecord }, unknown>;
  /**
   * Streamed generation. Optional so a non-streaming test double (and any
   * Provider implementation that omits the method) still satisfies the seam:
   * the generator falls back to `generate` when `stream` is absent.
   */
  stream?(spec: {
    turns: readonly { role: string; content: string }[];
    personalData: true;
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
          // The verbatim question the user asked — not the router's intent:
          // the engine stamps `sourceText` from the caller's query (ADR-0018).
          const question = context.query.sourceText;
          const evidence = context.turns.map((t) => t.content).join("\n");
          const turns: ChatTurn[] = [
            { role: "system", content: chatSystemPrompt(deps.language) },
            { role: "user", content: chatUserPrompt(question, evidence) },
          ];
          // The directed second reading is decided once, by the prompt module
          // that owns its copy (ADR-0055): a question naming no carried address,
          // or naming one the context does not hold, reads `null` and keeps the
          // plain reread below.
          const reread = addressedReread({
            question,
            context: evidence,
            chunks: context.chunks,
            language: deps.language,
          });
          // Bind the provider's own method before narrowing it. `Provider`
          // methods are class members on the fallback chain, so extracting
          // `stream` into a variable detaches `this` — and the chain's first
          // act is `this.eligibleEffectFor(spec)`, which then dies with
          // "Cannot read properties of undefined". Narrowing here (rather than
          // a `!` inside the stage) still keeps the invariant in the type.
          const provider = deps.provider;
          const stream = provider.stream?.bind(provider);
          // One attempt is one paid reading of the same turns; its cost is
          // recorded whether or not the draft it produced is the one that ships.
          // A directed reading also records the labels it was pointed at, so a
          // refusal can be segmented by whether its second reading was directed.
          const attempt = (
            purpose: string,
            reading: readonly ChatTurn[],
            addressed?: readonly string[],
          ) =>
            Effect.gen(function* () {
              const streamed =
                stream !== undefined
                  ? yield* streamDraft(deps, stream, reading)
                  : yield* generateDraft(deps, reading);
              run.record({
                stage: "generator",
                kind: "llm_call",
                detail:
                  addressed === undefined ? { purpose } : { purpose, addressed: [...addressed] },
                cost: streamed.cost,
                at: run.now(),
              });
              return streamed;
            });
          let streamed = yield* attempt("generate", turns);
          // Only a pure refusal is reread: a draft that answered is final. A
          // refusal ships only when the reread declines too, and an empty
          // context has nothing to reread, so it is not paid for twice.
          for (
            let attemptIndex = 0;
            attemptIndex < REFUSAL_REREAD_LIMIT &&
            context.chunks.length > 0 &&
            isRefusalOnly(streamed.text);
            attemptIndex++
          ) {
            // A reread that cannot be read leaves the first refusal standing:
            // an optional second opinion must never become a run-level failure,
            // and the refusal is the safe direction. Its estimated spend stays
            // on the trace when the provider reports one.
            const next = yield* Effect.catch(
              attempt(
                reread?.purpose ?? "generate_reread",
                reread?.turns ?? turns,
                reread?.addressed,
              ),
              (failure) => {
                recordFailedAttempt(run, failure.cause);
                return Effect.succeed(undefined);
              },
            );
            if (next === undefined) break;
            if (!isRefusalOnly(next.text)) {
              streamed = next;
              break;
            }
          }
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
 * Record a failed attempt's estimated spend, when the provider reports one, so
 * a vendor-reaching attempt never vanishes from the cost trail (traceability
 * rule 4). The purpose is the runner's own label for a failed attempt: the call
 * produced no reading, so it is not labelled with one it never reached.
 */
function recordFailedAttempt(run: RunContextService, cause: unknown): void {
  if (!(cause instanceof ProviderError)) return;
  for (const cost of cause.attemptCosts ?? []) {
    run.record({
      stage: "generator",
      kind: "llm_call",
      detail: { purpose: "failed-attempt" },
      cost,
      at: run.now(),
    });
  }
}

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
      .generate({ turns, personalData: true })
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
 * `stream` is non-optional here: the caller narrows the provider's optional
 * method once, so the "stream exists" invariant is held by the parameter type
 * rather than a `!` assertion.
 */
function streamDraft(
  deps: KajianQGeneratorDeps,
  stream: NonNullable<GeneratorProvider["stream"]>,
  turns: readonly { role: string; content: string }[],
): Effect.Effect<{ text: string; cost: CostRecord }, { cause: unknown }> {
  return Effect.gen(function* () {
    const handle = yield* mapCause(stream({ turns, personalData: true }));
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
