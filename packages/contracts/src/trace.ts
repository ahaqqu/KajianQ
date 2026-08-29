import * as v from "valibot";

/**
 * Cost attribution for a single LLM/embedding call. Model identity arrives as
 * an opaque string resolved from `model_configs` at wiring time — contracts
 * never name a vendor or model (ADR-0009).
 */
export const CostRecordSchema = v.object({
  modelId: v.pipe(v.string(), v.minLength(1)),
  tokensIn: v.pipe(v.number(), v.integer(), v.minValue(0)),
  tokensOut: v.pipe(v.number(), v.integer(), v.minValue(0)),
  latencyMs: v.pipe(v.number(), v.minValue(0)),
  /** Computed monetary cost in micro-USD to keep integer arithmetic exact. */
  costMicroUsd: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * True when tokens were estimated (e.g. a vendor that reports no streamed
   * usage) rather than metered — a trace must never present an estimate as
   * metered (ADR-0022). Optional so pre-existing records stay readable;
   * absent means metered.
   */
  estimated: v.optional(v.boolean()),
});

export type CostRecord = v.InferOutput<typeof CostRecordSchema>;

/**
 * Pipeline stages of the DARS engine (ADR-0005). Generic on purpose: domain
 * specifics (metadata filters, labels, prompt templates) arrive as typed event
 * payloads, never as engine-named concepts.
 */
export const StageSchema = v.picklist([
  "router",
  "retriever",
  "assembler",
  "generator",
  "reviewer",
  "ingest",
  "eval",
]);

export type Stage = v.InferOutput<typeof StageSchema>;

/**
 * A retrieved-chunk reference inside a `retrieval` event (ADR-0007). Carries
 * the two channel ranks plus the fused score so the Trace panel can show
 * retrieval provenance per chunk.
 */
export const ChunkRefSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  score: v.optional(v.number()),
  rankDense: v.optional(v.number()),
  rankSparse: v.optional(v.number()),
});

/**
 * Every recordable pipeline occurrence, keyed on `kind` with `detail` typed
 * per variant (#45; ADR-0007 amendment "typed, checked every change"). An
 * unknown `kind` or a malformed `detail` now fails `v.parse` instead of
 * persisting an untyped record.
 *
 * Split of responsibility: the pipeline runner emits the deterministic
 * stage-boundary events (`intent`, `subquery`, `retrieval`, `assembly`) from
 * each stage's structured result; stages that call an LLM or suppress an
 * answer append `llm_call`, `refusal`, and `review` through the run's trace
 * sink — the single collection point (ADR-0021).
 *
 * `intent.attributes` is the one deliberately-opaque slot: it carries
 * domain-specific structured data (routing filters, tags) that the engine
 * passes through without naming it. Everything else is typed.
 */
export const TraceEventSchema = v.variant("kind", [
  v.object({
    stage: v.literal("router"),
    kind: v.literal("intent"),
    detail: v.object({
      intent: v.pipe(v.string(), v.minLength(1)),
      confidence: v.optional(v.number()),
      reasoning: v.optional(v.string()),
      /** Domain-specific structured data (routing filters, tags). */
      attributes: v.optional(v.record(v.string(), v.unknown())),
    }),
    cost: v.optional(CostRecordSchema),
    at: v.pipe(v.number(), v.integer()),
  }),
  v.object({
    stage: v.literal("router"),
    kind: v.literal("subquery"),
    detail: v.object({
      text: v.pipe(v.string(), v.minLength(1)),
    }),
    cost: v.optional(CostRecordSchema),
    at: v.pipe(v.number(), v.integer()),
  }),
  v.object({
    stage: v.literal("retriever"),
    kind: v.literal("retrieval"),
    detail: v.object({
      chunks: v.array(ChunkRefSchema),
    }),
    cost: v.optional(CostRecordSchema),
    at: v.pipe(v.number(), v.integer()),
  }),
  v.object({
    stage: v.literal("assembler"),
    kind: v.literal("assembly"),
    detail: v.object({
      turnCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
      chunkCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
    cost: v.optional(CostRecordSchema),
    at: v.pipe(v.number(), v.integer()),
  }),
  v.object({
    stage: StageSchema,
    kind: v.literal("llm_call"),
    detail: v.optional(
      v.object({
        /** Caller-supplied label (e.g. "intent", "translate", "generate"). */
        purpose: v.optional(v.string()),
      }),
    ),
    cost: v.optional(CostRecordSchema),
    at: v.pipe(v.number(), v.integer()),
  }),
  v.object({
    stage: v.literal("reviewer"),
    kind: v.literal("review"),
    detail: v.object({
      verdict: v.pipe(v.string(), v.minLength(1)),
    }),
    cost: v.optional(CostRecordSchema),
    at: v.pipe(v.number(), v.integer()),
  }),
  v.object({
    stage: StageSchema,
    kind: v.literal("refusal"),
    detail: v.optional(
      v.object({
        trigger: v.optional(v.string()),
      }),
    ),
    reason: v.pipe(v.string(), v.minLength(1)),
    cost: v.optional(CostRecordSchema),
    at: v.pipe(v.number(), v.integer()),
  }),
]);

export type TraceEvent = v.InferOutput<typeof TraceEventSchema>;

/** The enumerated event kinds; the discriminator of {@link TraceEventSchema}. */
export type TraceEventKind = TraceEvent["kind"];

/**
 * The per-answer record of how it was built. The PWA renders this shape; it
 * never reconstructs "how the answer was built" ad hoc. Invariant: a trace's
 * total cost equals the sum of its events' LLM costs — `totalCost` is derived
 * by the persister, so it cannot drift from the events.
 *
 * Forward-compatibility contract: `version` is the schema anchor. The Trace
 * shape may only ever *add optional* fields (version-bumped); it must never
 * add a required field or rename/remove an existing one without migrating
 * persisted traces. The RagStore reader uses `v.parse`, which tolerates
 * missing optional fields and strips unknown future keys, so older persisted
 * traces stay readable as the contract evolves (ADR-0007 amendment).
 */
export const TraceSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  /** Schema version, starting at 1. Older persisted traces read as unset. */
  version: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  createdAt: v.pipe(v.number(), v.integer()),
  events: v.array(TraceEventSchema),
});

export type Trace = v.InferOutput<typeof TraceSchema>;

/** Sum of the trace's recorded per-event LLM costs, in micro-USD. */
export function totalCostMicroUsd(trace: Trace): number {
  return trace.events.reduce((sum, e) => sum + (e.cost?.costMicroUsd ?? 0), 0);
}

/**
 * Validate and return a Trace, throwing on a malformed event. The pipeline
 * runner calls this once when assembling the final trace so a mis-shaped or
 * unknown-kind event fails the run instead of persisting silently (ADR-0007
 * amendment, #45).
 */
export function parseTrace(trace: unknown): Trace {
  return v.parse(TraceSchema, trace);
}
