import type { Trace } from "@app/contracts";
import type { Effect, Scope } from "effect";
import type { DefaultFilters, RunContext } from "./context";
import type { StageError } from "./errors";

/** Re-exported so stage authors import the filter vocabulary from one module. */
export type { DefaultFilters } from "./context";

/**
 * A question moving through the pipeline. Generic over `TFilters` so the
 * domain pack instantiates `Query<KajianQFilters>`; the engine default is the
 * open string map for domain-agnostic callers.
 */
export type Query<TFilters extends Record<string, unknown> = DefaultFilters> = {
  text: string;
  /** Caller-chosen filter dimensions, passed through untouched. */
  filters?: TFilters;
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

export type RoutedQuery<TFilters extends Record<string, unknown> = DefaultFilters> = {
  intent: string;
  subQueries: readonly Query<TFilters>[];
  filters: TFilters;
};

/**
 * The turns handed to the Generator. The Assembler owns context *selection
 * and ordering* (Principles first, then evidence); the Generator owns the
 * final prompt to the Provider, so the context carries a structured turn
 * list, not a frozen string. Keeping `Turn` minimal (role + content) lets the
 * Generator re-template, stream a preamble, or apply reviewer-driven
 * reformatting without re-parsing (ADR-0018). `role` is opaque to the engine
 * — the domain pack names the roles its prompt templates use.
 */
export type Turn = {
  role: string;
  content: string;
};

export type AssembledContext<TFilters extends Record<string, unknown> = DefaultFilters> = {
  /** The routed query the Generator is answering — intent, sub-queries, filters. */
  query: RoutedQuery<TFilters>;
  chunks: readonly Chunk[];
  /** Ordered turns for the Generator to send to the Provider. */
  turns: readonly Turn[];
};

/**
 * The Generator's draft — rendered text only. The run owns the full Trace as
 * its single collection point (ADR-0007, ADR-0021), so a stage that calls the
 * LLM records its `llm_call`/`refusal` events through the run's sink instead
 * of returning a half-built trace.
 */
export type Draft = {
  text: string;
};

/** The pipeline result: the rendered answer plus its full Trace (ADR-0007). */
export type Answer = {
  text: string;
  trace: Trace;
};

/**
 * A stage method's full effect shape: failure is a typed `StageError`, and
 * the requirement channel carries the run's `RunContext` service (config,
 * clock, trace sink) plus the run's `Scope` for per-run finalizers (ADR-0027).
 */
export type StageEffect<A> = Effect.Effect<A, StageError, RunContext | Scope.Scope>;

/**
 * Router: intent & principle detection, query decomposition, source routing.
 * Not a mere classifier. Implementations hold an injected Provider; they never
 * name a vendor. Accesses the run through the `RunContext` Tag so it can
 * record `llm_call` cost and register per-run finalizers via `Effect.addFinalizer`.
 */
export interface Router<TFilters extends Record<string, unknown> = DefaultFilters> {
  route(query: Query<TFilters>): StageEffect<RoutedQuery<TFilters>>;
}

/** Retriever: hybrid search over the store, fused and scored. */
export interface Retriever<TFilters extends Record<string, unknown> = DefaultFilters> {
  retrieve(routed: RoutedQuery<TFilters>): StageEffect<readonly Chunk[]>;
}

/**
 * Assembler: pack retrieved chunks into the Generator's context. Produces the
 * ordered turn list; the Generator owns final prompt assembly.
 */
export interface Assembler<TFilters extends Record<string, unknown> = DefaultFilters> {
  assemble(query: Query<TFilters>, chunks: readonly Chunk[]): StageEffect<AssembledContext<TFilters>>;
}

/**
 * Generator: produce the grounded answer from the assembled turns. Receives
 * the routed query (intent, filters) so it can branch the system prompt and
 * apply citation discipline. Calls the LLM through the Provider seam and
 * records tokens/latency/cost into the run's trace (ADR-0018, ADR-0007).
 */
export interface Generator<TFilters extends Record<string, unknown> = DefaultFilters> {
  generate(context: AssembledContext<TFilters>): StageEffect<Draft>;
}

/**
 * Reviewer: cross-checks the draft against the retrieved evidence and emits a
 * verdict; refusals/suppressions are recorded with reason and stage through
 * the run's sink.
 */
export interface Reviewer<TFilters extends Record<string, unknown> = DefaultFilters> {
  review(draft: Draft, context: AssembledContext<TFilters>): StageEffect<Draft>;
}
