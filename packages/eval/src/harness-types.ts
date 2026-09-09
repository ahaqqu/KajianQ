/**
 * Structural shapes the harness consumes. Narrow, structural views of the
 * @app/contracts Trace/ChunkRef types — the harness reads persisted traces
 * through these so it never depends on contract internals beyond the types
 * it re-exports.
 */

/** The subset of a trace's retrieval-event chunk ref the harness reads. */
export type ChunkRefLike = {
  id: string;
  score?: number;
  rankDense?: number;
  rankSparse?: number;
};

/** The subset of the contracts Trace the harness reads. */
export type RetrievalLike = {
  kind: string;
  stage: string;
  detail?: { chunks?: ChunkRefLike[] };
  at?: number;
};

/** The event's cost record, structurally matching @app/contracts CostRecord. */
export type CostRecordLike = {
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costMicroUsd: number;
  estimated?: boolean;
};

/** Any trace event shape (kind-discriminated) the harness inspects. */
export type TraceEventLike = {
  kind: string;
  stage?: string;
  detail?: { chunks?: ChunkRefLike[]; purpose?: string };
  /** The event's cost record (thermo-review B1: feeds the report's costs). */
  cost?: CostRecordLike;
  at?: number;
};
