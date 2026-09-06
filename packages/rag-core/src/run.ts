import { Effect } from "effect";
import { parseTrace, type Trace, type TraceEvent } from "@app/contracts";
import { RunContext, type RunConfig, type RunContextService } from "./context";
import { StageError } from "./errors";
import { ProviderError } from "./provider";
import type {
  Answer,
  Assembler,
  Chunk,
  DefaultFilters,
  Draft,
  Generator,
  Query,
  Retriever,
  Reviewer,
  Router,
} from "./pipeline";

/** The five wired pipeline stages, one of each (ADR-0005). */
export type PipelineStages<TFilters extends Record<string, unknown> = DefaultFilters> = {
  router: Router<TFilters>;
  retriever: Retriever<TFilters>;
  assembler: Assembler<TFilters>;
  generator: Generator<TFilters>;
  reviewer: Reviewer<TFilters>;
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
 * Walk the five stages in order and assemble the full Trace (ADR-0021, ADR-0027).
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
    const routed = yield* stages.router.route(query);
    events.push({
      stage: "router",
      kind: "intent",
      detail: { intent: routed.intent, attributes: routed.filters },
      at: now(),
    });
    for (const sub of routed.subQueries) {
      events.push({
        stage: "router",
        kind: "subquery",
        detail: { text: sub.text },
        at: now(),
      });
    }

    const chunks = yield* stages.retriever.retrieve(routed);
    events.push({
      stage: "retriever",
      kind: "retrieval",
      detail: { chunks: chunks.map(toChunkRef) },
      at: now(),
    });

    const context = yield* stages.assembler.assemble(query, chunks);
    events.push({
      stage: "assembler",
      kind: "assembly",
      detail: { turnCount: context.turns.length, chunkCount: context.chunks.length },
      at: now(),
    });

    const draft: Draft = yield* stages.generator.generate(context);
    const finalDraft = yield* stages.reviewer.review(draft, context);

    const trace = yield* Effect.try({
      try: () =>
        parseTrace({
          id: options.traceId ?? crypto.randomUUID(),
          createdAt: now(),
          events,
        }),
      catch: (cause): StageError => new StageError({ stage: "pipeline", cause }),
    });

    return { text: finalDraft.text, trace };
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
function toChunkRef(chunk: Chunk): {
  id: string;
  score?: number;
  rankDense?: number;
  rankSparse?: number;
} {
  const ref: { id: string; score?: number; rankDense?: number; rankSparse?: number } = {
    id: chunk.id,
  };
  if (chunk.score !== undefined) ref.score = chunk.score;
  if (chunk.rankDense !== undefined) ref.rankDense = chunk.rankDense;
  if (chunk.rankSparse !== undefined) ref.rankSparse = chunk.rankSparse;
  return ref;
}
