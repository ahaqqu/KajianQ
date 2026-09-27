import type { EvalResultOutcome, GoldenQuestion } from "@app/contracts";
import type { Budget } from "./budget";

/**
 * Structural shapes the harness consumes. Narrow, structural views of the
 * @app/contracts Trace/ChunkRef types — the harness reads persisted traces
 * through these so it never depends on contract internals beyond the types
 * it re-exports — plus the harness's own transport/ledger/deps seam types,
 * kept here so `harness.ts` stays inside the agentic-limits line cap.
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

/**
 * The calendar-date assertion detector the grounded-decline acceptance
 * (#244) uses, injected by the composition root (the domain pack owns the
 * vocabulary; the engine package must not). The contract is narrow: does this
 * text assert a Gregorian or Hijri date? The domain implementation is
 * `assertsCalendarDate`, and its patterns are literal — the engine never
 * compiles a regex from data.
 *
 * Absent on purpose in a unit context: with no detector injected the
 * acceptance fails closed (no extra acceptance), so a caller that omits it
 * cannot accidentally weaken a trap.
 */
export type DateAssertionDetector = (text: string) => boolean;

/**
 * One question's answer from the target, plus the server's structured
 * citations frame (ADR-0040) when the transport consumed one. Absent for a
 * transport that does not carry it (a fake, an older client); citation
 * scoring then falls back to the trace's `grounded` labels and finally the
 * answer text.
 */
export type ChatTransportResult = {
  text: string;
  messageId: string | null;
  traceId: string | null;
  /**
   * The server's structured citations frame (ADR-0040), when the transport
   * consumed one. Absent for a transport that does not carry it (a fake, an
   * older client); citation scoring then falls back to the trace's `grounded`
   * labels and finally the answer text.
   */
  citations?: CitationFrameLike | null;
};

/** One question's round-trip against the target. */
export interface ChatTransport {
  ask(question: GoldenQuestion): Promise<ChatTransportResult>;
}

/** Fetch one answer's trace events by message id (the store adapter bridges). */
export interface AnswerTraceSource {
  eventsByMessage(messageId: string): Promise<readonly TraceEventLike[] | null>;
}

/**
 * The eval-ledger persistence role (the RagStore adapter bridges). The
 * harness owns the run lifecycle: `createRun` first (thermo-review A3/A4 —
 * the pre-fix loop saved per-question rows with a blank run id the store's
 * `::uuid` cast rejects, and persisted the report with an id no caller ever
 * stamped back), `saveResult` per question, `refreshRun` to store the final
 * report against the run id in a single idempotent write (no CLI
 * double-write, A9).
 */
export interface RunLedger {
  createRun(label: string, report: unknown): Promise<string>;
  /** Idempotent upsert of the final report row (by run id). */
  refreshRun(runId: string, label: string, report: unknown): Promise<void>;
  saveResult(
    runId: string,
    questionId: string,
    outcome: EvalResultOutcome,
    traceId: string | null,
  ): Promise<string>;
}

/** Everything one harness run is wired with (all domain vocabulary injected). */
export type HarnessDeps = {
  transport: ChatTransport;
  traces: AnswerTraceSource;
  ledger: RunLedger;
  /** Chunk-id → source-type resolver (from the store or fixture metadata). */
  sourceTypeOf: (chunkId: string) => string | undefined;
  budget: Budget;
  /** Refusal markers in the answer text (domain vocabulary, caller-supplied). */
  refusalMarkers?: readonly string[];
  /**
   * The citation grammar the scorer uses on the text fallback (domain
   * vocabulary, caller-supplied — the engine stays agnostic). Supplied by the
   * CLI composition root from `@app/kajianq-domain`, so the scorer and the
   * deterministic gate normalize labels identically. Omitted in a unit
   * context: scoring then falls back to the byte-exact substring check.
   */
  citationGrammar?: CitationGrammar;
  /**
   * The calendar-date assertion detector the grounded-decline acceptance (#244)
   * uses — the domain pack's `assertsCalendarDate`, injected by the CLI
   * composition root. Omitted ⇒ the acceptance fails closed.
   */
  dateAssertions?: DateAssertionDetector;
  /**
   * The opaque `origin` label the domain pack puts on chunks its scope
   * expansion added (ADR-0045), supplied by the composition root exactly like
   * `refusalMarkers`/`citationGrammar` — the engine package must not hard-code
   * a caller's label. When set, each scored outcome records the expansion's
   * contribution to that question (C1: a scoped pass is visible in the report,
   * never folded silently into `retrievalRecall`). Omitted = no accounting and
   * no `expansion` block on the outcome.
   */
  expansionOrigin?: string;
  /** Run label persisted with the report. */
  label?: string;
  now?: () => number;
};

/** One persisted outcome, correlated to the trace it was scored from. */
export type HarnessQuestionResult = EvalResultOutcome & { traceId: string | null };

/** The settled result of one whole-set run. */
export type HarnessRunResult = {
  runId: string;
  passed: number;
  failed: number;
  skipped: number;
  budgetExceeded: boolean;
  results: HarnessQuestionResult[];
};
