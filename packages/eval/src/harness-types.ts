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
  /**
   * The ref's opaque origin label (ADR-0045), when the trace carries one.
   * Opaque on purpose: the harness compares it against the caller-supplied
   * `expansionOrigin` and never interprets what the label means.
   */
  origin?: string;
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
    /** The reviewer's raw verdict payload (contracts `review` event detail). */
    verdict?: string;
    /**
     * The retrieved citation labels the reviewer's deterministic gate found in
     * the answer (contracts `review` event, thermo-review B4). Optional: older
     * persisted traces predate it, which is the signal to fall back to the text.
     */
    grounded?: string[];
    /**
     * The `scope_expansion` event's typed detail (ADR-0045), structurally
     * mirroring the contract. The harness reads the event's KIND to know the
     * scoped path ran (C1) and never interprets these opaque fields; they are
     * listed so a trace fixture stays the real shape.
     */
    key?: string;
    value?: string;
    returned?: number;
    cap?: number;
    truncated?: boolean;
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
 * package must not). Every member is one of the SAME functions the
 * deterministic gate (`validateCitations`) and the citations-frame derivation
 * use, so the scorer and the gate cannot disagree about what a citation is.
 *
 * Absent on purpose in a unit context: with no grammar injected the scorer
 * keeps its original raw-substring behavior, so local tests are unchanged.
 */
export type CitationGrammar = {
  /** Normalize a label: collapse whitespace, strip a grade suffix, canonicalize markers. */
  normalizeLabel: (label: string) => string;
  /** Every citation-shaped span in the text, ALREADY normalized. */
  labelsInText: (text: string) => string[];
  /**
   * Every address one label **names**, in the grammar's own spelling: a list
   * for a form whose citation names several (a range citation, whose interior
   * is included — `QS. 2:255-260` names all six), and the label itself for an
   * ordinary citation. **Required**: a grammar with no list-valued form says so
   * as `(label) => [label]`, so an injector is always obliged to answer what a
   * label names (review R1 of the #274 fix round — while this member was
   * optional, deleting one property in the JavaScript composition root was a
   * silent return to the pre-range comparison).
   *
   * The scorer needs it because a required citation and the answer's evidence
   * are not the same SHAPE: a question requires `QS. 2:255`, the answer cites
   * `QS. 2:255-256`, and the gate grounds it — comparing the two as strings
   * alone scored a correctly grounded answer 0 (review A1 of the #274 fix
   * round). Injected from the domain pack (`addressesNamedBy`), so the range's
   * semantics has one owner and the engine learns no domain vocabulary. The
   * runtime half of this contract is `citation-grammar.ts`, called from the
   * engine's grammar-consuming entry: the composition root is JavaScript, so
   * the type alone cannot keep it honest.
   */
  addressesNamedBy: (label: string) => readonly string[];
};
