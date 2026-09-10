import type { CostRecordLike } from "./harness-types";

/**
 * EmbeddingBenchmark (#9, ADR-0013/0014): the domain-agnostic measurement
 * machinery for the retrieval-posture gate. The engine owns the metric math
 * (recall@k, MRR, gate evaluation) and the candidate loop shape; the corpus
 * texts, query fixtures, and model ids all arrive from the caller — this
 * module never names a vendor, a model, or an Islamic source (AGENTS.md
 * rule 1).
 *
 * Design (ADR-0013 §Affected tickets, #9 row): the gate metric is explicit
 * recall over the real corpus, not a hosted leaderboard — the caller embeds
 * a corpus and a query set per candidate model through the Provider seam and
 * hands the (query, expected-relevant-ids) pairs in. The same vectors are
 * scored against every metric direction, so one embedding pass per model
 * serves all rows of the report.
 */

/** One embedded corpus entry: an opaque id plus its two track texts. */
export type BenchDoc = {
  id: string;
  /** The canonical/primary-track text (the evidence layer, e.g. Arabic). */
  textPrimary: string;
  /** The secondary/fallback-track text (e.g. Indonesian). */
  textSecondary: string;
};

/**
 * One retrieval probe: a query text plus the corpus ids that count as
 * relevant for it. `relevantIds` must be a subset of the corpus ids the
 * caller embedded; recall@k is computed against this ground truth.
 */
export type BenchQuery = {
  id: string;
  text: string;
  relevantIds: readonly string[];
};

/**
 * Which corpus track a probe searches and which text the query is drawn
 * from. Directions are the ADR-0013 gate rows: cross-lingual (query in one
 * language, corpus in the other) and monolingual baseline.
 */
export type BenchDirection = "primary→primary" | "secondary→primary" | "secondary→secondary";

/** The metrics for one (model, direction) cell. */
export type BenchCell = {
  direction: BenchDirection;
  queries: number;
  /** Mean recall@k over the direction's queries (0..1; null when none ran). */
  recallAtK: number | null;
  /** Mean reciprocal rank (0..1; null when none ran). */
  mrr: number | null;
};

/** One candidate model's full benchmark result, including its spend. */
export type BenchCandidateResult = {
  /** Opaque model id (as resolved from config). */
  modelId: string;
  cells: BenchCell[];
  /** Sum of the candidate's embedding CostRecords (micro-USD). */
  costMicroUsd: number;
  /** Wall-clock embedding time (ms), for the report. */
  elapsedMs: number;
};

/** The k of recall@k (spec §7 gate: recall@10). */
export const BENCH_K = 10;

/** Cosine similarity between two unit-normalizable vectors. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * Rank corpus ids by similarity to the query vector, best first. Pure and
 * deterministic — exported so tests pin the metric math.
 */
export function rankDocs(
  queryVector: readonly number[],
  docVectors: readonly { id: string; vector: readonly number[] }[],
): { id: string; score: number }[] {
  const scored = docVectors.map((d) => ({
    id: d.id,
    score: cosineSimilarity(queryVector, d.vector),
  }));
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored;
}

/** Recall@k: |relevant ∩ topK| / |relevant|; 0 when ground truth is empty. */
export function recallAtK(
  relevantIds: readonly string[],
  ranked: readonly { id: string }[],
  k: number = BENCH_K,
): number {
  if (relevantIds.length === 0) return 0;
  const top = new Set(ranked.slice(0, k).map((r) => r.id));
  const hits = relevantIds.filter((id) => top.has(id)).length;
  return hits / relevantIds.length;
}

/** Reciprocal rank: 1/rank of the first relevant hit (0 when none in top k). */
export function reciprocalRank(
  relevantIds: readonly string[],
  ranked: readonly { id: string }[],
  k: number = BENCH_K,
): number {
  const relevant = new Set(relevantIds);
  for (let i = 0; i < Math.min(ranked.length, k); i += 1) {
    if (relevant.has(ranked[i]!.id)) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Score one direction: for each probe, rank the corpus (embedded with the
 * query in the same call set) and aggregate recall@k + MRR. `queryVectors`
 * and `docVectors` must come from the same embedding model — mixing models
 * invalidates cosine similarity.
 */
export function scoreDirection(
  direction: BenchDirection,
  queryVectors: readonly { query: BenchQuery; vector: readonly number[] }[],
  docVectors: readonly { id: string; vector: readonly number[] }[],
): BenchCell {
  if (queryVectors.length === 0) {
    return { direction, queries: 0, recallAtK: null, mrr: null };
  }
  let recallSum = 0;
  let mrrSum = 0;
  for (const { query, vector } of queryVectors) {
    const ranked = rankDocs(vector, docVectors);
    recallSum += recallAtK(query.relevantIds, ranked);
    mrrSum += reciprocalRank(query.relevantIds, ranked);
  }
  return {
    direction,
    queries: queryVectors.length,
    recallAtK: recallSum / queryVectors.length,
    mrr: mrrSum / queryVectors.length,
  };
}

/**
 * The gate floors (issue #9, accepted threshold): the default embedding
 * model ships only if cross-lingual secondary→primary recall@10 ≥ 0.70 AND
 * the monolingual primary→primary baseline recall@10 ≥ 0.75.
 */
export const GATE_FLOORS = {
  crossLingual: 0.7,
  monolingual: 0.75,
} as const;

/**
 * Evaluate a candidate against the gate. `posture` is the retrieval posture
 * the numbers imply (recorded, not decided here): a passing cross-lingual
 * cell keeps AR-only serving; a failing cross-lingual cell with a passing
 * fallback track implies the fusion posture. Pure — exported for tests.
 */
export function evaluateGate(result: { cells: readonly BenchCell[] }): {
  crossLingualPass: boolean;
  monolingualPass: boolean;
  gatePass: boolean;
} {
  const cellOf = (d: BenchDirection) => result.cells.find((c) => c.direction === d);
  const cross = cellOf("secondary→primary");
  const mono = cellOf("primary→primary");
  const crossLingualPass = (cross?.recallAtK ?? 0) >= GATE_FLOORS.crossLingual;
  const monolingualPass = (mono?.recallAtK ?? 0) >= GATE_FLOORS.monolingual;
  return {
    crossLingualPass,
    monolingualPass,
    gatePass: crossLingualPass && monolingualPass,
  };
}

/** One expansion micro-task case (ADR-0014): slice + query → correct term. */
export type ExpansionCase = {
  id: string;
  /** The Indonesian query in natural user wording. */
  query: string;
  /** The verbalized glossary slice offered to the router LLM (opaque JSON). */
  slice: unknown;
  /** The Arabic expansion term a correct selection must include. */
  expectedTerm: string;
  /** Distractor Arabic terms from the same slice the model must not pick. */
  distractors: readonly string[];
};

/** One expansion micro-task outcome. */
export type ExpansionOutcome = {
  caseId: string;
  /** True when the model's selection includes the expected term. */
  correct: boolean;
  /** The raw terms the model picked (post-parse, lowercase-trimmed). */
  picked: readonly string[];
  /** Non-null when the model's reply could not be parsed into terms. */
  parseError?: string;
};

/** Extract lowercase-trimmed Arabic terms from the model's JSON answer. */
export function parseExpansionSelection(text: string): readonly string[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return [];
    const terms = (parsed as { terms?: unknown }).terms;
    if (!Array.isArray(terms)) return [];
    return terms
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
  } catch {
    return [];
  }
}

/** Score one expansion case: correct when any picked term equals expected. */
export function scoreExpansionCase(
  outcome: Pick<ExpansionOutcome, "picked" | "parseError">,
  expectedTerm: string,
): boolean {
  if (outcome.parseError !== undefined) return false;
  return outcome.picked.includes(expectedTerm.trim().toLowerCase());
}

/** Cost records collected across a benchmark run (traceability rule 2). */
export type BenchCostSink = {
  add: (cost: CostRecordLike) => void;
};

/** Aggregated cost totals for the report. */
export function totalCostMicroUsd(costs: readonly CostRecordLike[]): number {
  return costs.reduce((sum, c) => sum + (c.costMicroUsd ?? 0), 0);
}
