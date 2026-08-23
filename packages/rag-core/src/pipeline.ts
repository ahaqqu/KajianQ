import type { Trace } from "@app/contracts";

/**
 * A question moving through the pipeline. Metadata filters and labels are
 * opaque to the engine — the domain pack (e.g. kajianq-domain) supplies their
 * values; the engine only threads them through typed fields.
 */
export type Query = {
  text: string;
  /** Caller-chosen filter dimensions, passed through untouched. */
  filters?: Record<string, string | readonly string[]>;
};

/** A unit of retrieved evidence with its scoring provenance. */
export type Chunk = {
  id: string;
  text: string;
  /** Retrieval provenance for the Trace (rrf_score, rank_dense, rank_sparse). */
  score?: number;
  rankDense?: number;
  rankSparse?: number;
  metadata?: Record<string, unknown>;
};

export type RoutedQuery = {
  intent: string;
  subQueries: readonly Query[];
  filters: Record<string, string | readonly string[]>;
};

export type AssembledContext = {
  chunks: readonly Chunk[];
  prompt: string;
};

/** The pipeline result: the rendered answer plus its full Trace (ADR-0007). */
export type Answer = {
  text: string;
  trace: Trace;
};

/**
 * Router: intent & principle detection, query decomposition, source routing.
 * Not a mere classifier. Implementations hold an injected Provider; they never
 * name a vendor.
 */
export interface Router {
  route(query: Query): Promise<RoutedQuery>;
}

/** Retriever: hybrid search over the store, fused and scored. */
export interface Retriever {
  retrieve(routed: RoutedQuery): Promise<readonly Chunk[]>;
}

/** Assembler: pack retrieved chunks into the generator's context. */
export interface Assembler {
  assemble(query: Query, chunks: readonly Chunk[]): Promise<AssembledContext>;
}

/**
 * Generator: produce the grounded answer. Calls the LLM through the Provider
 * seam and records tokens/latency/cost into the trace.
 */
export interface Generator {
  generate(context: AssembledContext): Promise<Answer>;
}

/**
 * Reviewer: cross-checks the draft against the retrieved evidence and emits a
 * verdict; refusals/suppressions are recorded with reason and stage.
 */
export interface Reviewer {
  review(answer: Answer, context: AssembledContext): Promise<Answer>;
}
