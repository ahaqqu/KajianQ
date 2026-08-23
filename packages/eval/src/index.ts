/**
 * eval — domain-agnostic evaluation harness.
 *
 * Skeleton seam for the DARS engine: runs a stored question set against the
 * pipeline and scores answers against expected citations. The engine owns the
 * measurement machinery; the versioned question set contents and expected
 * sources come from the product, never named here.
 *
 * The real harness arrives with the Golden Set ticket (#8) against the
 * RagStore (#4) and Provider (#5) seams. This skeleton exists so the package
 * boundary and typed contract are in place from the foundation.
 */

import type { Answer } from "@app/rag-core";

/** One evaluation case: a question plus the evidence an answer must cite. */
export type EvalCase = {
  id: string;
  question: string;
  /** Expected supporting chunk ids / citations, opaque to the engine. */
  expected: readonly string[];
};

/** Aggregate scores for a batch run. */
export type EvalReport = {
  cases: number;
  passed: number;
  /** Per-case detail keyed by EvalCase id. */
  detail: Record<string, { passed: boolean; score?: number }>;
};

/** Score one produced answer against an eval case. */
export interface Scorer {
  score(kase: EvalCase, answer: Answer): Promise<{ passed: boolean; score?: number }>;
}
