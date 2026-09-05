import type { CostRecord, IngestionReport } from "@app/contracts";
import type { RagStore } from "@app/infra";
import type { Provider } from "@app/rag-core";

/**
 * Type contracts for the ingestion pipeline (#6). Kept in a dedicated module
 * so `pipeline.ts` holds the orchestration and this file stays the seam map
 * implementers program against.
 */

/** A coarse container document, parsed from a source. */
export type ParsedParent = {
  /** Provenance key; unique per source — the store upserts on it. */
  sourceKey: string;
  title: string | null;
  metadata: Record<string, unknown>;
  children: readonly ParsedChild[];
};

/**
 * A fine-grained chunk under a parent. `ordinal` is the stable position
 * within the parent; the engine re-derives it when the parser omits it, but a
 * parser that supplies it must supply it consistently across re-runs.
 */
export type ParsedChild = {
  sourceKey: string;
  textRaw: string;
  textPrimary: string;
  textSecondary: string | null;
  citation: Record<string, unknown>;
  metadata: Record<string, unknown>;
  ordinal?: number;
};

/** Parse raw source bytes into the parent/child document tree. */
export type SourceParser = (input: SourceInput) => Promise<readonly ParsedParent[]>;

/** Raw source bytes plus their archive identity (fetched + archived upstream). */
export type SourceInput = {
  /** Archive key the raw bytes were stored under (R2); recorded in the report. */
  archiveKey: string;
  /** The raw bytes as fetched from the source, immutable (AGENTS.md rule 11). */
  raw: Uint8Array;
};

/**
 * The domain-supplied summarizer for parent documents: parents carry LLM
 * summaries and parent embeddings are computed *from the summary*, not the
 * full text (issue #6 AC). Receives an opaque domain title + child texts; the
 * engine treats the prompt as the domain's business. Returns the call's
 * CostRecord alongside the summary so the pipeline's collector records it —
 * the report's cost is the sum of every recorded call, and an LLM call whose
 * cost is dropped is a traceability defect (review A6).
 */
export type ParentSummarizer = (input: {
  sourceKey: string;
  title: string | null;
  childTexts: readonly string[];
}) => Promise<{ summary: string; cost: CostRecord }>;

/** An aligned (primary, secondary) pair handed to the run's optional sink. */
export type AlignedPairInput = {
  pairKey: string;
  citation: Record<string, unknown>;
  textPrimary: string;
  textSecondary: string;
  morphology: readonly Record<string, unknown>[];
};

/** Knobs for one ingestion run; production wiring supplies the seams. */
export type IngestionDeps = {
  store: RagStore;
  /** Embeds both tracks; model identity comes from config at wiring time. */
  embedder: Provider;
  /** LLM-backed parent summarizer; null disables parent summaries. */
  summarizer: ParentSummarizer | null;
  /**
   * Optional aligned-pair sink: receives every (primary, secondary) pair the
   * run writes, in child order. The domain uses it to feed the terminology
   * build's seed table (ADR-0014); the engine treats the pair shape as
   * opaque and only guarantees it matches the written children.
   */
  pairSink?: (input: AlignedPairInput) => Promise<void>;
  /** Batch size for embedding calls (per track). */
  embedBatchSize?: number;
  /** Batch size for child/pair store writes. */
  writeBatchSize?: number;
  now?: () => number;
};

/** Result of one run: the persisted report plus per-parent write counts. */
export type IngestionRunResult = {
  report: IngestionReport;
  parentIds: readonly string[];
};

/**
 * Cost-collecting sink for the run. Every LLM/embedding call the pipeline
 * makes lands here so the report's cost is the sum of recorded calls — an
 * untraced call is a rule-4 defect, so the collector is the single place
 * costs accumulate (kajianq-traceability litmus: cost equals sum of calls).
 */
export class CostCollector {
  readonly #calls: CostRecord[] = [];

  /** Record one call's cost. Returns the record for call-site convenience. */
  record(cost: CostRecord): CostRecord {
    this.#calls.push(cost);
    return cost;
  }

  get calls(): readonly CostRecord[] {
    return this.#calls;
  }

  get costMicroUsd(): number {
    return this.#calls.reduce((sum, c) => sum + c.costMicroUsd, 0);
  }
}