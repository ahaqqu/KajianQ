import * as v from "valibot";
import { ChunkRefSchema, CostRecordSchema, StageSchema } from "./trace-primitives";
import { productRulesEventSchema } from "./trace-product-rules";
import { sourceRoutingEventSchema } from "./trace-source-routing";

/**
 * Every recordable pipeline occurrence, keyed on `kind` with `detail` typed per
 * variant: an unknown `kind` or a malformed `detail` fails `v.parse` instead of
 * persisting an untyped record. The runner emits the deterministic stage-boundary
 * events; stages that call an LLM or suppress an answer append their own through
 * the run's trace sink — the single collection point. `intent.attributes` is the
 * one deliberately-opaque slot; everything else is typed. One union owns every
 * kind: `kind` is the only discriminator, so no reader branches on a module.
 */
export const TraceEventSchema = v.variant("kind", [
  v.object({
    stage: v.literal("router"),
    kind: v.literal("intent"),
    detail: v.object({
      intent: v.pipe(v.string(), v.minLength(1)),
      confidence: v.optional(v.number()),
      reasoning: v.optional(v.string()),
      attributes: v.optional(v.record(v.string(), v.unknown())),
    }),
    cost: v.optional(CostRecordSchema),
    /** The stage's wall-clock duration in milliseconds, measured by the runner;
     * a stage with no boundary event carries it in `cost.latencyMs`. */
    durationMs: v.optional(v.pipe(v.number(), v.minValue(0))),
    at: v.pipe(v.number(), v.integer()),
  }),
  /** Smart Router stage 3's decision; owner `./trace-source-routing`. */
  sourceRoutingEventSchema,
  v.object({
    stage: v.literal("router"),
    kind: v.literal("subquery"),
    detail: v.object({
      text: v.pipe(v.string(), v.minLength(1)),
      /** Caller-chosen opaque labels for why this sub-query exists and what
       * produced it; the engine interprets neither. */
      role: v.optional(v.pipe(v.string(), v.minLength(1))),
      origin: v.optional(v.pipe(v.string(), v.minLength(1))),
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
    /** The stage's wall-clock duration, measured by the runner (see `intent`). */
    durationMs: v.optional(v.pipe(v.number(), v.minValue(0))),
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
    /** The stage's wall-clock duration, measured by the runner (see `intent`). */
    durationMs: v.optional(v.pipe(v.number(), v.minValue(0))),
    at: v.pipe(v.number(), v.integer()),
  }),
  v.object({
    stage: v.literal("retriever"),
    kind: v.literal("filter_relaxed"),
    detail: v.object({
      /**
       * The inferred filter dimensions a search gave up because they matched
       * nothing, and the values it gave up (a bare string or a list — both
       * parse). One dimension per probe, so the effective record is `intended −
       * every ADOPTED drop before it`; the retry is traced, never silent.
       */
      dropped: v.record(
        v.string(),
        v.union([v.string(), v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1))]),
      ),
      /** The filter record the retry ran with, carried so a reader need not
       * replay the event order. */
      retained: v.optional(
        v.record(v.string(), v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1))),
      ),
      /**
       * Whether the drop was KEPT: only a drop that returns hits is adopted, so
       * `false` is a probe that changed nothing. Naming every live dimension is
       * the record-level last resort.
       */
      adopted: v.optional(v.boolean()),
      /** Which embedding track the relaxation applied to. */
      track: v.pipe(v.string(), v.minLength(1)),
      /** Hits the relaxed retry returned; `0` means the drop did not help. */
      hits: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    }),
    cost: v.optional(CostRecordSchema),
    at: v.pipe(v.number(), v.integer()),
  }),
  v.object({
    /** A deterministic scope expansion: the retriever added a bounded set of
     * children of a domain-named scope. `key`/`value` are opaque. */
    stage: v.literal("retriever"),
    kind: v.literal("scope_expansion"),
    detail: v.object({
      key: v.pipe(v.string(), v.minLength(1)),
      value: v.pipe(v.string(), v.minLength(1)),
      /** Children added; the configured cap; whether the scope held more children
       * than the cap read from its opening ordinal. A child the caller already
       * held is read but not added, and does not raise the flag. */
      returned: v.pipe(v.number(), v.integer(), v.minValue(0)),
      cap: v.pipe(v.number(), v.integer(), v.minValue(0)),
      truncated: v.boolean(),
    }),
    cost: v.optional(CostRecordSchema),
    at: v.pipe(v.number(), v.integer()),
  }),
  v.object({
    /** A deterministic neighbourhood expansion: the retriever added the children
     * neighbouring the verses already in context; `anchors` are the ids the read
     * was keyed on, in its priority order. */
    stage: v.literal("retriever"),
    kind: v.literal("neighbour_expansion"),
    detail: v.object({
      anchors: v.array(v.pipe(v.string(), v.minLength(1))),
      /** Children added; the configured radius, cap, and truncation flag. This cap
       * bounds the chunks that reach the context, so the flag says the read offered
       * more neighbours outside it than the cap could add — not that the read was
       * cut short by rows the caller already held. */
      returned: v.pipe(v.number(), v.integer(), v.minValue(0)),
      radius: v.pipe(v.number(), v.integer(), v.minValue(0)),
      cap: v.pipe(v.number(), v.integer(), v.minValue(0)),
      truncated: v.boolean(),
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
      /** The retrieved citation labels the answer actually cited — the
       * deterministic gate's *pass* case. */
      grounded: v.optional(v.array(v.string())),
      /** True when the reviewer's reply carried no readable verdict:
       * distinguishes "passed" from "output unusable". */
      verdictParseFailed: v.optional(v.boolean()),
    }),
    cost: v.optional(CostRecordSchema),
    at: v.pipe(v.number(), v.integer()),
  }),
  /** The deterministic product rules ran; owner `./trace-product-rules`. */
  productRulesEventSchema,
  v.object({
    /**
     * A decision-model call's verdict: the shape every stage that asks a
     * `Decider` to screen its fast path records. The call's spend rides on a
     * sibling `llm_call` event.
     */
    stage: StageSchema,
    kind: v.literal("decision"),
    detail: v.object({
      /** Caller-supplied label for the screen (e.g. "citation_support"). */
      purpose: v.optional(v.string()),
      /**
       * What the call concluded about the stage's fast path: `skip` clears it,
       * `escalate` defers to the stage's existing path. Fail-open is caller-side:
       * an unusable answer and a vendor failure both land on `escalate`.
       */
      outcome: v.picklist(["skip", "escalate"]),
      /**
       * Why the call escalated — absent on a `skip`. Closed vocabulary, generic
       * by design: `below_threshold` (a scored item missed the threshold),
       * `no_items` (nothing to judge), `malformed_answer` (no usable vendor
       * answer for an item), `vendor_failure` (the call itself failed).
       */
      reason: v.optional(
        v.picklist(["below_threshold", "no_items", "malformed_answer", "vendor_failure"]),
      ),
      /** The per-item score threshold the outcome was computed against. */
      threshold: v.optional(v.number()),
      /** Per-item verdicts in request order: `index` the caller's position, `key`
       * its identity in the request, `score` the vendor's answer (absent = no
       * usable answer for that item). */
      items: v.array(
        v.object({
          index: v.pipe(v.number(), v.integer(), v.minValue(0)),
          key: v.pipe(v.string(), v.minLength(1)),
          score: v.optional(v.number()),
        }),
      ),
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
