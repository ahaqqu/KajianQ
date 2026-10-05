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
  /**
   * Prior conversation turns, oldest first (multi-turn chat — ADR-0018).
   * The engine passes them through opaquely; the domain pack
   * decides whether and how the Assembler renders them. Absent = single-turn.
   */
  history?: readonly Turn[];
};

/** A unit of retrieved evidence with its scoring provenance. */
export type Chunk = {
  id: string;
  text: string;
  /** Retrieval provenance for the Trace (rrf_score, rank_dense, rank_sparse). */
  score?: number;
  rankDense?: number;
  rankSparse?: number;
  /**
   * Why this chunk is in the retrieved set, as a caller-chosen opaque label
   * (ADR-0045). Absent means the retriever's fused tracks produced it; a
   * retriever that adds chunks by another path labels them so the Trace can
   * tell the two apart. The engine never interprets the label.
   */
  origin?: string;
  metadata?: Record<string, unknown>;
};

/**
 * One retrieval query a question was decomposed into. `role` and `origin` are
 * caller-chosen opaque labels (like `Chunk.origin`): the engine carries them
 * into the Trace and interprets neither — the domain pack names the roles its
 * composition rules use and the origins its repair records.
 */
export type SubQuery = {
  text: string;
  /** What the sub-query is for (domain vocabulary; opaque to the engine). */
  role?: string;
  /** What produced it — the router's model or a deterministic rule (opaque). */
  origin?: string;
};

/**
 * What a Router understood: the classification, the decomposed sub-queries,
 * the filters its reading implies, and the optional evidence for that reading.
 * `confidence`/`reasoning`/`attributes` are the router's own account of its
 * classification — the engine types them (so the Trace can carry them) and
 * names nothing inside `attributes`.
 */
export type Routing<TFilters extends Record<string, unknown> = DefaultFilters> = {
  intent: string;
  subQueries: readonly SubQuery[];
  filters: TFilters;
  /** The router's self-reported confidence in `intent`, if it reports one. */
  confidence?: number;
  /** The router's own rationale for the classification, if it gives one. */
  reasoning?: string;
  /** Domain-specific structured data (classification tags, effective filters). */
  attributes?: Record<string, unknown>;
};

/**
 * The run's query after routing: the caller's query context plus the router's
 * reading of it. The runner builds it (the router returns only {@link Routing}),
 * which is why the verbatim `sourceText` and the caller's `history` are
 * guaranteed present downstream instead of being echo fields a router could
 * get wrong. Every stage after the Router receives this one object.
 */
export type RoutedQuery<TFilters extends Record<string, unknown> = DefaultFilters> =
  Routing<TFilters> & {
    /**
     * The verbatim caller question this routing decomposed, stamped by the
     * runner. It exists because a domain retriever may need to apply a
     * *deterministic* rule keyed on what the user actually asked (e.g. ADR-0045's
     * scope expansion), and a model-generated sub-query paraphrase is not a
     * faithful stand-in — the same question routed twice yields different
     * sub-query wording. The engine never inspects it.
     */
    sourceText: string;
    /** The caller's prior turns, stamped by the runner (ADR-0018). */
    history?: readonly Turn[];
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
 * Returns {@link Routing} — what it understood — not the run's query: the
 * runner stamps the caller's verbatim text and history onto it.
 */
export interface Router<TFilters extends Record<string, unknown> = DefaultFilters> {
  route(query: Query<TFilters>): StageEffect<Routing<TFilters>>;
}

/** Retriever: hybrid search over the store, fused and scored. */
export interface Retriever<TFilters extends Record<string, unknown> = DefaultFilters> {
  retrieve(routed: RoutedQuery<TFilters>): StageEffect<readonly Chunk[]>;
}

/**
 * Assembler: pack retrieved chunks into the Generator's context. Produces the
 * ordered turn list; the Generator owns final prompt assembly. Receives the
 * *routed* query — the run's query context plus the router's reading — so the
 * context it returns carries that reading rather than a rebuilt lookalike
 * (ADR-0018).
 */
export interface Assembler<TFilters extends Record<string, unknown> = DefaultFilters> {
  assemble(
    routed: RoutedQuery<TFilters>,
    chunks: readonly Chunk[],
  ): StageEffect<AssembledContext<TFilters>>;
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
