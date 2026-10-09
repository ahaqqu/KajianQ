import * as v from "valibot";
import { CostRecordSchema } from "./trace-primitives";

/**
 * Smart Router **stage 3**'s decision, as its own trace variant (spec §3.3
 * item 3): the source types the route selected and the metadata filter record
 * retrieval was told to run with.
 *
 * It is a variant rather than a field on the `intent` event because the two
 * answer different questions and must be readable apart. `intent` is *what the
 * system understood*; `source_routing` is *what it decided to do about it* —
 * which sources were in play and with which filters. Burying the second inside
 * `intent.attributes` made "the model hinted `textLayer: sharh`" and "the route
 * decided to search only the Quran" the same opaque bag, so a trace reader
 * could not tell a decision from a suggestion.
 *
 * The filter keys and values stay opaque strings the domain pack owns — this
 * module names no dimension, no source type and no domain vocabulary. A route
 * that selected no source records an EMPTY `sources` list: "every source was in
 * play" is a decision, and it must not read the same as a trace that recorded
 * none.
 *
 * Owner module, composed verbatim into the closed {@link TraceEventSchema}
 * union: `kind` stays the only discriminator and no reader branches on a
 * module (the split `trace-product-rules` takes, for the same 300-line cap).
 */
/** The variant's `detail` payload, composed into {@link sourceRoutingEventSchema}. */
export const sourceRoutingDetailSchema = v.object({
  sources: v.array(v.pipe(v.string(), v.minLength(1))),
  filters: v.record(v.string(), v.array(v.pipe(v.string(), v.minLength(1)))),
});

export const sourceRoutingEventSchema = v.object({
  stage: v.literal("router"),
  kind: v.literal("source_routing"),
  detail: sourceRoutingDetailSchema,
  cost: v.optional(CostRecordSchema),
  /** The stage's wall-clock duration, measured by the runner (see `intent`). */
  durationMs: v.optional(v.pipe(v.number(), v.minValue(0))),
  at: v.pipe(v.number(), v.integer()),
});
