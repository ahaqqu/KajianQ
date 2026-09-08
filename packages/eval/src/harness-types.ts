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

/** Any trace event shape (kind-discriminated) the harness inspects. */
export type TraceEventLike = RetrievalLike;
