/** Narrow structural views of the @app/contracts Trace/ChunkRef types the harness reads. */

/** The subset of a trace's retrieval-event chunk ref the harness reads. */
export type ChunkRefLike = {
  id: string;
  score?: number;
  rankDense?: number;
  rankSparse?: number;
  /** The ref's opaque origin label (ADR-0045); compared, never interpreted. */
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
    /** The reviewer gate's grounded citation labels; absent falls back to the text. */
    grounded?: string[];
    /** The `scope_expansion` event's typed detail, mirroring the contract; only the
     * event's KIND is read, and the fields are listed so a fixture stays real. */
    key?: string;
    value?: string;
    returned?: number;
    cap?: number;
    remaining?: number;
    truncated?: boolean;
    skipped?: string;
    /** The `citation_lookup` event's resolved labels. */
    labels?: string[];
    /** The `citation_lookup` event's labels no stored row carried. */
    missing?: string[];
    /** The labels the lookup's grammar saw but did not resolve. */
    dropped?: { label: string; reason: string }[];
  };
  /** The event's cost record (feeds the report's costs). */
  cost?: CostRecordLike;
  at?: number;
};

/** The subset of the `citations` frame (ADR-0040) the harness scores with. Each input
 * has one role: the server-grounded `label` feeds citation validity, and the citing
 * chunk's `arabic`/`translation` text feeds quote fidelity (existence in that text, no
 * attribution). The frame's other fields (`grade`, `machineTranslated`, `source`) are
 * not read here. */
export type CitationFrameLike = {
  citations: readonly {
    label: string;
    /** The Arabic original of the cited chunk, when the frame carries it. */
    arabic?: string;
    /** The Indonesian translation of the cited chunk, when the frame carries it. */
    translation?: string;
  }[];
};

/** The chat-citation grammar the harness scores citation validity with, injected by
 * the composition root (the domain pack owns it; the engine must not). Every member
 * is one of the SAME functions the gate and the frame derivation use, so scorer and
 * gate cannot disagree; with no grammar the scorer keeps its raw-substring behavior. */
export type CitationGrammar = {
  /** Normalize a label: collapse whitespace, strip a grade suffix, canonicalize markers. */
  normalizeLabel: (label: string) => string;
  /** Every citation-shaped span in the text, ALREADY normalized. */
  labelsInText: (text: string) => string[];
  /**
   * Every address one label **names**, in the grammar's own spelling: a list for a
   * form whose citation names several (a range names its whole interior) and the
   * label itself otherwise. **Required**, so an injector always answers what a label
   * names. **`null` is the third state** — a declared list the grammar cannot
   * enumerate, so the citation is unverifiable and is treated as refused (neither
   * `[]` nor one address). Needed because a required citation and the answer's
   * evidence are not the same SHAPE (`QS. 2:255` required, `QS. 2:255-256` cited);
   * injected from the domain pack so the engine learns no domain vocabulary.
   */
  addressesNamedBy: (label: string) => readonly string[] | null;
};

/**
 * One language- or corpus-specific equivalence the quote scorer applies after its
 * generic fold, injected by the composition root. The scorer folds case, punctuation
 * and combining marks for every script; a rule such as a language's optional word
 * space is that caller's policy, not the engine's.
 *
 * `pattern` sees the folded, lower-cased text (letters, numbers and single spaces), so
 * it can be written against the words rather than their punctuation; include the `g`
 * flag when every occurrence must be replaced.
 */
export type QuoteEquivalence = {
  readonly pattern: RegExp;
  readonly replacement: string;
};

/**
 * The **canonical identity** of a citation label, injected by the composition
 * root. The engine compares opaque keys and learns no domain vocabulary; the
 * domain pack owns the curated map that assigns them.
 *
 * `identityOf` returns the canonical key for a label the map carries and `null`
 * for a label it does not — the fail-closed state the scorer keeps its exact
 * label comparison for. A fabricated or unmatched label therefore never
 * resolves into a group.
 */
export type CitationIdentity = {
  identityOf: (label: string) => string | null;
};
