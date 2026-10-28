import * as v from "valibot";
import { sourceRoutingDetailSchema } from "./trace-source-routing";

/**
 * One chunk reference in the user-facing Trace frame: the persisted
 * `retrieval` event's provenance (fused score, both channel ranks, the
 * reranker's score, the opaque `origin` label) plus the server-joined display
 * title. The top "sources consulted" layer reuses the shape with those fields
 * absent.
 *
 * `source` is joined by chunk id — a missing row renders by id, never a
 * fabricated title. `rerankScore` sits beside `score` because the panel lists
 * the retrieval order — guarantee-led, then reranked — not a fused score order.
 */
export const ChatTraceChunkSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  source: v.optional(v.pipe(v.string(), v.minLength(1))),
  score: v.optional(v.number()),
  rankDense: v.optional(v.number()),
  rankSparse: v.optional(v.number()),
  rerankScore: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  origin: v.optional(v.pipe(v.string(), v.minLength(1))),
});

export type ChatTraceChunk = v.InferOutput<typeof ChatTraceChunkSchema>;

/**
 * One citation the reviewer pre-gate judged, as the persisted `decision` event
 * recorded it: the citation's position in the batched call (`index`), its label
 * (`key`), and the decision model's support probability (`score`). An item with
 * no `score` is one the pre-gate could not judge — the panel reads it as "not
 * judged", never as a zero.
 */
export const ChatTraceReviewerItemSchema = v.object({
  index: v.pipe(v.number(), v.integer(), v.minValue(0)),
  key: v.pipe(v.string(), v.minLength(1)),
  score: v.optional(v.number()),
});

export type ChatTraceReviewerItem = v.InferOutput<typeof ChatTraceReviewerItemSchema>;

/**
 * The reviewer pre-gate's verdict (ADR-0042), projected from the persisted
 * `decision` event: `skip` means every citation cleared the threshold and the
 * paid reviewer was skipped; `escalate` defers to it. `threshold` is the
 * support score the outcome was computed against, present only when the event
 * recorded one — a verdict is shown without its number rather than dropped, so
 * an escalation is never hidden. `items` are the per-citation judgements in
 * request order.
 *
 * `reason` carries the event's own value as an opaque string rather than a
 * picklist here: the vocabulary is the event's, and a value this frame has not
 * learned yet must not make an otherwise readable trace unparsable. The panel
 * labels the values it knows and shows any other verbatim.
 */
export const ChatTraceReviewerSchema = v.object({
  outcome: v.picklist(["skip", "escalate"]),
  reason: v.optional(v.string()),
  threshold: v.optional(v.number()),
  items: v.array(ChatTraceReviewerItemSchema),
});

export type ChatTraceReviewer = v.InferOutput<typeof ChatTraceReviewerSchema>;

/**
 * The user-facing Trace payload: how an answer was built, in two layers, both
 * derived SERVER-SIDE from the answer's persisted trace (`answer_traces`) — the
 * client renders the frame, never reconstructing pipeline machinery. The top
 * `sources` layer lists the sources consulted in plain language (retrieval
 * order, deduplicated); `technical` carries the router intent, the sub-queries,
 * the scored chunks, the model identities (opaque `modelId` strings from
 * `model_configs`), and the reviewer pre-gate's verdict when the trace recorded
 * one. Emitted live as the SSE `trace` frame (after `citations`, before `done`)
 * and per assistant message on the rehydration transcript; `messageId` names
 * the message it renders for, in both views.
 */
export const ChatTraceFrameSchema = v.object({
  messageId: v.pipe(v.string(), v.minLength(1)),
  sources: v.array(ChatTraceChunkSchema),
  technical: v.object({
    intent: v.optional(v.pipe(v.string(), v.minLength(1))),
    confidence: v.optional(v.number()),
    /**
     * The routing decision: which source types the route selected and the
     * metadata filter record retrieval should run with, projected verbatim from
     * the persisted trace's `source_routing` event. Opaque strings — the domain
     * pack owns what a source type or a filter dimension means. An empty
     * `sources` list is a decision ("every source was in play"), never
     * "unknown". `relaxed` names the dimensions the run gave up on the trace's
     * `filter_relaxed` events, so the effective record is `filters − relaxed`;
     * a relaxed run would otherwise show a filter the search had already given
     * up. Shared with the trace variant's schema — only the drop list, which
     * lives on the retriever's events, is declared here.
     */
    routing: v.optional(
      v.object({
        ...sourceRoutingDetailSchema.entries,
        relaxed: v.optional(
          v.array(
            v.object({
              key: v.pipe(v.string(), v.minLength(1)),
              values: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
            }),
          ),
        ),
      }),
    ),
    subQueries: v.array(v.pipe(v.string(), v.minLength(1))),
    chunks: v.array(ChatTraceChunkSchema),
    /** Distinct model identities, in first-call order (opaque ids). */
    models: v.array(v.pipe(v.string(), v.minLength(1))),
    /** The reviewer pre-gate's verdict, when the persisted trace recorded one. */
    reviewer: v.optional(ChatTraceReviewerSchema),
  }),
});

export type ChatTraceFrame = v.InferOutput<typeof ChatTraceFrameSchema>;
