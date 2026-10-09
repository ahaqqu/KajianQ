import * as v from "valibot";
import { ChunkRefSchema, CostRecordSchema, StageSchema } from "./trace-primitives";
import { productRulesEventSchema } from "./trace-product-rules";
import { sourceRoutingEventSchema } from "./trace-source-routing";

/**
 * Every recordable pipeline occurrence, keyed on `kind` with `detail` typed
 * per variant (#45; ADR-0007 "typed, checked every change"). An
 * unknown `kind` or a malformed `detail` now fails `v.parse` instead of
 * persisting an untyped record.
 *
 * Split of responsibility: the pipeline runner emits the deterministic
 * stage-boundary events (`intent`, `subquery`, `retrieval`, `assembly`) from
 * each stage's structured result; stages that call an LLM or suppress an
 * answer append `llm_call`, `refusal`, `review`, and `product_rules` through
 * the run's trace sink — the single collection point (ADR-0021).
 *
 * A variant whose rationale would push this file past the agentic 300-line cap
 * gets its own module and is composed in verbatim here (that is why the field
 * schemas live in `./trace-primitives`); every variant is still one member of
 * this one union, so `kind` stays the only discriminator and no reader branches
 * on a module. `./trace-product-rules` holds the `product_rules` variant: that
 * split was forced when the union lived in `trace.ts` and had run out of room,
 * but with this file at 233 lines against the cap the module now stands as the
 * variant's home rather than a cap escape.
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
    /**
     * The stage's own wall-clock duration, in milliseconds, measured by the
     * runner around the stage call — recorded for EVERY stage on its boundary
     * event, so "stage latency per query" is on the trace even for a stage
     * that makes no model call and therefore has no `cost.latencyMs`. Absent on
     * traces persisted before the field existed.
     */
    durationMs: v.optional(v.pipe(v.number(), v.minValue(0))),
    at: v.pipe(v.number(), v.integer()),
  }),
  /** Smart Router stage 3's decision (#15); owner `./trace-source-routing`. */
  sourceRoutingEventSchema,
  v.object({
    stage: v.literal("router"),
    kind: v.literal("subquery"),
    detail: v.object({
      text: v.pipe(v.string(), v.minLength(1)),
      /**
       * Caller-chosen opaque labels for why this sub-query exists and what
       * produced it (e.g. a composition role and whether the model or a
       * deterministic rule supplied it). The engine carries them into the
       * Trace and interprets neither — a repaired or fallback sub-query is
       * visible as such instead of passing for the model's own judgment.
       */
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
       * The ONE inferred filter dimension a search dropped because it matched
       * nothing, and the values it dropped (a single string, or the list a
       * set-valued dimension carried). One dimension per event on purpose: the
       * search's effective filter record is then `intended − every dropped
       * dimension recorded before it`, so the trace says *which* hint was
       * wrong instead of "all of them were". Recorded so a relaxation is
       * VISIBLE machinery, never a silent fallback (traceability rule): the
       * router's filters are hints inferred by a cheap model, and an inferred
       * hint that empties the result set makes the answer ungrounded — so the
       * search is retried without it, and the trace says so. Values were
       * strings before set-valued dimensions existed; both parse.
       */
      dropped: v.record(
        v.string(),
        v.union([v.string(), v.array(v.pipe(v.string(), v.minLength(1)))]),
      ),
      /**
       * The filter record the retry actually ran with — `intended` minus this
       * drop and every earlier one. Carried directly as well as derivable, so
       * a reader never has to replay the event order to know what was searched.
       */
      retained: v.optional(v.record(v.string(), v.array(v.pipe(v.string(), v.minLength(1))))),
      /** Which embedding track the relaxation applied to. */
      track: v.pipe(v.string(), v.minLength(1)),
      /**
       * Hits the relaxed retry returned. `0` means the drop did not help —
       * the search had nothing to give, and the next dimension (or none) is
       * given up. Absent on traces persisted before the field existed.
       */
      hits: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    }),
    cost: v.optional(CostRecordSchema),
    durationMs: v.optional(v.pipe(v.number(), v.minValue(0))),
    at: v.pipe(v.number(), v.integer()),
  }),
  v.object({
    /** A deterministic scope expansion (ADR-0045): the retriever added a
     * bounded set of children of a domain-named scope, alongside the fused
     * hits. `key`/`value` are opaque; `cap`/`truncated` show the budget. */
    stage: v.literal("retriever"),
    kind: v.literal("scope_expansion"),
    detail: v.object({
      key: v.pipe(v.string(), v.minLength(1)),
      value: v.pipe(v.string(), v.minLength(1)),
      /** Children added; the configured cap; whether it truncated them. */
      returned: v.pipe(v.number(), v.integer(), v.minValue(0)),
      cap: v.pipe(v.number(), v.integer(), v.minValue(0)),
      truncated: v.boolean(),
    }),
    cost: v.optional(CostRecordSchema),
    at: v.pipe(v.number(), v.integer()),
  }),
  v.object({
    /** A deterministic neighbourhood expansion (ADR-0049): the retriever added
     * the children neighbouring the verses already in context. `anchors` are
     * the ids the read was keyed on, in its priority order, so every added
     * chunk resolves to a read that produced it (same parent, within `radius`
     * ordinals of a named anchor) instead of to "the expansion, somehow". */
    stage: v.literal("retriever"),
    kind: v.literal("neighbour_expansion"),
    detail: v.object({
      anchors: v.array(v.pipe(v.string(), v.minLength(1))),
      /** Children added; the configured radius, cap, and truncation flag. */
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
      /**
       * The retrieved citation labels the answer actually cited (thermo-review
       * B4): the deterministic gate's *pass* case, recorded so citation
       * provenance is observable rather than discarded. Optional — older
       * persisted traces predate it (ADR-0007: Trace only ever ADDS optional
       * fields).
       */
      grounded: v.optional(v.array(v.string())),
      /**
       * True when the reviewer LLM's reply carried no readable verdict
       * (thermo-review A3): distinguishes "reviewer passed" from "reviewer
       * output was unusable" so the eval harness can count indeterminate
       * reviews instead of reading both as a pass.
       */
      verdictParseFailed: v.optional(v.boolean()),
    }),
    cost: v.optional(CostRecordSchema),
    at: v.pipe(v.number(), v.integer()),
  }),
  /** The deterministic product rules ran (#285); owner `./trace-product-rules`. */
  productRulesEventSchema,
  v.object({
    /**
     * A decision-model call's verdict (ADR-0042 serving pattern): the shape
     * every stage that asks a `Decider` to screen its fast path records, so a
     * later adoption (retrieval screening, rerank) reuses it verbatim instead
     * of inventing a per-stage variant. The call's own spend rides on a
     * sibling `llm_call` event like every other model call, so the trace total
     * stays the sum of recorded calls.
     */
    stage: StageSchema,
    kind: v.literal("decision"),
    detail: v.object({
      /** Caller-supplied label for the screen (e.g. "citation_support"). */
      purpose: v.optional(v.string()),
      /**
       * What the call concluded about the stage's fast path: `skip` clears it
       * (the stage may take the cheap path and skip the expensive one),
       * `escalate` defers to the stage's existing path. Fail-open is a
       * caller-side classification rule, not a wire option: an unusable
       * answer and a vendor failure both land on `escalate`.
       */
      outcome: v.picklist(["skip", "escalate"]),
      /**
       * Why the call escalated — absent on a `skip`. The vocabulary is
       * generic (the decision seam is domain-agnostic): `below_threshold` (a
       * scored item missed the threshold), `no_items` (there was nothing to
       * judge, so nothing could be cleared), `malformed_answer` (the vendor
       * returned no usable answer for at least one item), `vendor_failure`
       * (the call itself failed).
       */
      reason: v.optional(
        v.picklist(["below_threshold", "no_items", "malformed_answer", "vendor_failure"]),
      ),
      /** The per-item score threshold the outcome was computed against. */
      threshold: v.optional(v.number()),
      /**
       * Per-item verdicts in request order. `index` is the caller's item
       * position, `key` its identity in the decision request, `score` the
       * vendor's Noul answer (absent = no usable answer for that item, e.g.
       * on a vendor failure or a malformed response).
       */
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
