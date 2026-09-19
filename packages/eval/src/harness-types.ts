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
  detail?: {
    chunks?: ChunkRefLike[];
    purpose?: string;
    /**
     * The retrieved citation labels the reviewer's deterministic gate found in
     * the answer (contracts `review` event, thermo-review B4). Optional: older
     * persisted traces predate it, which is the signal to fall back to the text.
     */
    grounded?: string[];
  };
  /** The event's cost record (thermo-review B1: feeds the report's costs). */
  cost?: CostRecordLike;
  at?: number;
};

/**
 * The subset of the `citations` frame (ADR-0040) the harness reads for
 * citation scoring: the labels the SERVER grounded against the persisted
 * trace. Structural on purpose — the harness never depends on the rest of the
 * frame (Arabic, translation, badges), only on the label list.
 */
export type CitationFrameLike = {
  citations: readonly { label: string }[];
};

/**
 * The chat-citation grammar the harness scores citation validity with,
 * injected by the composition root (the domain pack owns it; the engine
 * package must not). Both members are the SAME functions the deterministic
 * gate (`validateCitations`) and the citations-frame derivation use, so the
 * scorer and the gate cannot disagree about what a citation is.
 *
 * Absent on purpose in a unit context: with no grammar injected the scorer
 * keeps its original raw-substring behavior, so local tests are unchanged.
 */
export type CitationGrammar = {
  /** Normalize a label: collapse whitespace, strip a grade suffix, canonicalize markers. */
  normalizeLabel: (label: string) => string;
  /** Every citation-shaped span in the text, ALREADY normalized. */
  labelsInText: (text: string) => string[];
};
