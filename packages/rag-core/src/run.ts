import { parseTrace, type TraceEvent } from "@app/contracts";
import type {
  Answer,
  Assembler,
  AssembledContext,
  Chunk,
  DefaultFilters,
  Draft,
  Generator,
  Query,
  Retriever,
  Reviewer,
  Router,
} from "./pipeline";
import type { Disposer, RunConfig, RunContext } from "./context";

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
 * Walk the five stages in order and assemble the full Trace (ADR-0021).
 *
 * The runner is the single place that owns the run: it creates the
 * `RunContext` (config + trace sink + disposal scope), emits the deterministic
 * stage-boundary events (`intent`, `subquery`, `retrieval`, `assembly`) from
 * stage results, validates the assembled trace, and tears down deferred
 * resources LIFO — even when a stage throws.
 */
export async function runPipeline<TFilters extends Record<string, unknown> = DefaultFilters>(
  stages: PipelineStages<TFilters>,
  query: Query<TFilters>,
  config: RunConfig<TFilters> = {},
  options: RunOptions = {},
): Promise<Answer> {
  const now = options.now ?? Date.now;
  const events: TraceEvent[] = [];
  const disposers: Disposer[] = [];

  const run: RunContext<TFilters> = {
    config,
    now,
    record: (event) => {
      events.push(event);
    },
    defer: (disposer) => {
      disposers.push(disposer);
    },
  };

  try {
    const routed = await stages.router.route(query, run);
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

    const chunks = await stages.retriever.retrieve(routed, run);
    events.push({
      stage: "retriever",
      kind: "retrieval",
      detail: { chunks: chunks.map(toChunkRef) },
      at: now(),
    });

    const context = await stages.assembler.assemble(query, chunks, run);
    events.push({
      stage: "assembler",
      kind: "assembly",
      detail: { turnCount: context.turns.length, chunkCount: context.chunks.length },
      at: now(),
    });

    const draft = await stages.generator.generate(context, run);
    const finalDraft = await stages.reviewer.review(draft, context, run);

    const trace = parseTrace({
      id: options.traceId ?? crypto.randomUUID(),
      createdAt: now(),
      events,
    });

    return { text: finalDraft.text, trace };
  } finally {
    for (let i = disposers.length - 1; i >= 0; i -= 1) {
      const disposer = disposers[i];
      if (disposer) await disposer();
    }
  }
}

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
