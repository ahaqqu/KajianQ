import { Effect } from "effect";
import { parseTrace, type TraceEvent } from "@app/contracts";
import { RunContext } from "./context";
import type { RunConfig, RunContextService } from "./context";
import { StageError } from "./errors";
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

  return program.pipe(Effect.provideService(RunContext, run), Effect.scoped);
};

/** Project a Chunk into the retrieval event's typed chunk reference. */
function toChunkRef(
  chunk: Chunk,
): { id: string; score?: number; rankDense?: number; rankSparse?: number } {
  const ref: { id: string; score?: number; rankDense?: number; rankSparse?: number } = {
    id: chunk.id,
  };
  if (chunk.score !== undefined) ref.score = chunk.score;
  if (chunk.rankDense !== undefined) ref.rankDense = chunk.rankDense;
  if (chunk.rankSparse !== undefined) ref.rankSparse = chunk.rankSparse;
  return ref;
}
