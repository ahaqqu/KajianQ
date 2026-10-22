import { Effect } from "effect";
import { parseTrace, type ChunkRef, type Trace, type TraceEvent } from "@app/contracts";
import { RunContext, type RunConfig, type RunContextService } from "./context";

export type { RunConfig };
import { StageError, ProviderError } from "./errors";
import type {
  Answer,
  Assembler,
  Chunk,
  Decline,
  Decliner,
  DefaultFilters,
  Draft,
  Generator,
  Query,
  Retriever,
  Reviewer,
  RoutedQuery,
  Router,
} from "./pipeline";

/**
 * The five wired pipeline stages, one of each (ADR-0005), plus the optional
 * decline seam. `decliner` is not a sixth walk step but the runner's early
 * exit: wiring it is what lets a run answer without entering the two stages
 * that can spend.
 */
export type PipelineStages<TFilters extends Record<string, unknown> = DefaultFilters> = {
  router: Router<TFilters>;
  retriever: Retriever<TFilters>;
  assembler: Assembler<TFilters>;
  generator: Generator<TFilters>;
  reviewer: Reviewer<TFilters>;
  decliner?: Decliner<TFilters>;
};

/** Injectable run knobs; production defaults are the ambient clock + a UUID. */
export type RunOptions = {
  now?: () => number;
  traceId?: string;
  /**
   * Invoked exactly once when the run FAILS, with the run's collected events
   * parsed into a Trace — including any failed vendor attempts' costs the
   * runner recorded from the `ProviderError`'s `attemptCosts` (traceability
   * guardrail: a failed answer's trace stays visible to the trace store;
   * successful runs deliver their trace on the returned `Answer`). Skipped
   * if the collected events are not a valid Trace — a malformed event must
   * never mask the run's original failure.
   */
  onFailedTrace?: (trace: Trace) => void;
};

/**
 * Walk the five stages in order and assemble the full Trace (ADR-0021, ADR-0027),
 * stopping at the decline seam when one is wired and it returns a verdict.
 *
 * The runner is the single place that owns the run: it opens the run's
 * `Scope` (per-run `Effect.addFinalizer` teardown, LIFO, even when a stage
 * fails or the fiber is interrupted), provides the `RunContext` service
 * (config + trace sink + clock), emits the deterministic stage-boundary
 * events (`intent`, `subquery`, `retrieval`, `assembly`) from stage results,
 * and validates the assembled trace. A stage failure surfaces as its
 * `StageError`; the caller bridges to a promise via `Effect.runPromise`.
 * Failures keep their trail: failed vendor attempts' `attemptCosts` are
 * recorded into the trace sink, and `onFailedTrace` delivers the failed
 * run's parsed Trace (traceability guardrail — no untraced failure).
 */
export const runPipeline = <TFilters extends Record<string, unknown> = DefaultFilters>(
  stages: PipelineStages<TFilters>,
  query: Query<TFilters>,
  config: RunConfig<TFilters> = {},
  options: RunOptions = {},
): Effect.Effect<Answer, StageError> => {
  const now = options.now ?? Date.now;
  const events: TraceEvent[] = [];

  const run: RunContextService = {
    config,
    now,
    record: (event) => {
      events.push(event);
    },
  };

  const program = Effect.gen(function* () {
    // Every stage's wall clock is measured here, by the single owner of the
    // run, and stamped on the stage's boundary event. A stage that makes no
    // model call has no `cost.latencyMs` to read, so without this the
    // deterministic half of the pipeline — routing rules, the store round
    // trips, assembly — had no latency on the trace at all, and "stage latency
    // per query" was answerable only for the stages that spent money.
    const routerStartedAt = now();
    const routing = yield* stages.router.route(query);
    const routerMs = now() - routerStartedAt;
    // The run's query after routing: the router supplies only its reading of
    // the question, and the runner stamps the caller's verbatim text and prior
    // turns onto it. Stamping here (not in each router) is what makes
    // `sourceText` and `history` guaranteed for every stage downstream, and
    // leaves a router no echo field to get wrong (ADR-0018).
    const routed: RoutedQuery<TFilters> = {
      ...routing,
      sourceText: query.text,
      ...(query.history !== undefined ? { history: query.history } : {}),
    };
    events.push({
      stage: "router",
      kind: "intent",
      detail: {
        intent: routed.intent,
        ...(routed.confidence !== undefined ? { confidence: routed.confidence } : {}),
        ...(routed.reasoning !== undefined ? { reasoning: routed.reasoning } : {}),
        ...(routed.attributes !== undefined ? { attributes: routed.attributes } : {}),
      },
      durationMs: routerMs,
      at: now(),
    });
    for (const sub of routed.subQueries) {
      events.push({
        stage: "router",
        kind: "subquery",
        detail: {
          text: sub.text,
          ...(sub.role !== undefined ? { role: sub.role } : {}),
          ...(sub.origin !== undefined ? { origin: sub.origin } : {}),
        },
        at: now(),
      });
    }

    const retrieveStartedAt = now();
    const chunks = yield* stages.retriever.retrieve(routed);
    events.push({
      stage: "retriever",
      kind: "retrieval",
      detail: { chunks: chunks.map(toChunkRef) },
      durationMs: now() - retrieveStartedAt,
      at: now(),
    });

    const assembleStartedAt = now();
    const context = yield* stages.assembler.assemble(routed, chunks);
    events.push({
      stage: "assembler",
      kind: "assembly",
      detail: { turnCount: context.turns.length, chunkCount: context.chunks.length },
      durationMs: now() - assembleStartedAt,
      at: now(),
    });

    // The decline seam, and the run's only early exit: it is asked after
    // assembly and before the two stages that can spend, so a run whose route
    // carries nothing to generate for never enters the Generator or the
    // Reviewer — no call, no cost, by construction rather than by the model's
    // restraint. The runner writes the record itself, from the verdict's own
    // `reason`/`trigger`, so a decline is never a bare response: the delivered
    // copy and the trace's account of it are written at the same boundary, and
    // a decliner cannot decline without the trace saying so. Its `text` replaces
    // what the Generator would have drafted, so the `refusal` event is the
    // trace's delivery record and the verdict's `trigger` names why.
    if (stages.decliner !== undefined) {
      const declined = yield* stages.decliner.decline(routed, context);
      if (declined !== null) {
        events.push(refusalEventOf(declined, now()));
        return {
          text: declined.text,
          trace: yield* assembleTrace(options, events, now),
        };
      }
    }

    const draft: Draft = yield* stages.generator.generate(context);
    const finalDraft = yield* stages.reviewer.review(draft, context);

    return {
      text: finalDraft.text,
      trace: yield* assembleTrace(options, events, now),
    };
  });

  return program.pipe(
    // A failed vendor attempt that reached the vendor may never vanish from
    // the cost trail: record the ProviderError's `attemptCosts` into the
    // run's trace sink before the failure propagates (AGENTS.md rule 4).
    Effect.tapError((err) =>
      Effect.sync(() => {
        recordFailedAttemptCosts(err, run);
      }),
    ),
    Effect.provideService(RunContext, run),
    Effect.onExit((exit) =>
      Effect.sync(() => {
        // C3: a failed run's collected events are still a valid Trace —
        // deliver them so the failure stays visible to the trace store.
        if (options.onFailedTrace && exit._tag === "Failure") {
          const trace = parseTraceSafe({
            id: options.traceId ?? crypto.randomUUID(),
            createdAt: now(),
            events,
          });
          if (trace) options.onFailedTrace(trace);
        }
      }),
    ),
    Effect.scoped,
  );
};

/**
 * The trace's record of a decline, written by the runner from the verdict it
 * was handed — the delivered text is the caller's own copy rather than a
 * draft, which is the fact the `refusal` event kind records for every reader of
 * it; `trigger` names this decline's own reason. It carries no `cost`, and
 * there is no `llm_call` beside it: the decline is the one answer path that
 * makes no call at all.
 */
function refusalEventOf(declined: Decline, at: number): TraceEvent {
  return {
    stage: "generator",
    kind: "refusal",
    ...(declined.trigger !== undefined ? { detail: { trigger: declined.trigger } } : {}),
    reason: declined.reason,
    at,
  };
}

/**
 * Parse the run's collected events into its Trace — the run's single collection
 * point, on every exit (ADR-0007).
 */
function assembleTrace(
  options: RunOptions,
  events: TraceEvent[],
  now: () => number,
): Effect.Effect<Trace, StageError> {
  return Effect.try({
    try: () =>
      parseTrace({
        id: options.traceId ?? crypto.randomUUID(),
        createdAt: now(),
        events,
      }),
    catch: (cause): StageError => new StageError({ stage: "pipeline", cause }),
  });
}

/**
 * Record the failed attempts' estimated spend (the `ProviderError`'s
 * `attemptCosts`) as `llm_call` events in the run's trace sink, in the order
 * the attempts happened. Nothing records for a runner-level failure (no
 * stage, no vendor contact) or an error without a `ProviderError` cause.
 */
function recordFailedAttemptCosts(err: StageError, run: RunContextService): void {
  if (err.stage === "pipeline") return;
  const provider = err.cause instanceof ProviderError ? err.cause : undefined;
  for (const cost of provider?.attemptCosts ?? []) {
    run.record({
      stage: err.stage,
      kind: "llm_call",
      detail: { purpose: "failed-attempt" },
      cost,
      at: run.now(),
    });
  }
}

/** Parse collected events into a Trace, or undefined if a stage recorded a malformed one. */
function parseTraceSafe(trace: unknown): Trace | undefined {
  try {
    return parseTrace(trace);
  } catch {
    return undefined;
  }
}

/** Project a Chunk into the retrieval event's typed chunk reference. */
function toChunkRef(chunk: Chunk): ChunkRef {
  const ref: ChunkRef = { id: chunk.id };
  if (chunk.score !== undefined) ref.score = chunk.score;
  if (chunk.rankDense !== undefined) ref.rankDense = chunk.rankDense;
  if (chunk.rankSparse !== undefined) ref.rankSparse = chunk.rankSparse;
  if (chunk.rerankScore !== undefined) ref.rerankScore = chunk.rerankScore;
  if (chunk.origin !== undefined) ref.origin = chunk.origin;
  return ref;
}
