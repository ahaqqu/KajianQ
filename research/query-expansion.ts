/**
 * Multi-shape query expansion and candidate union.
 *
 * The measured mechanism (docs/research/experiments.md E6, E8–E10): three query shapes fail on
 * different rows, and their union puts the required passage in the top fifty for 15 of 17
 * questions where the user's own wording manages 12 — and in the top ten for 13 where it
 * manages 6. This module is the shape of the stage, not an integration: the retriever is
 * injected, so it can be tested without a store and wired into the pipeline behind a flag.
 *
 * Research artefact: not wired into the pipeline.
 */

/** The three query shapes, each a separate call in production so each can be traced. */
export type QueryShapes = {
  /** Differently-worded topical queries — classical terms, plain language, named subject. */
  readonly topics: readonly string[];
  /** A passage that would answer the question, written in the corpus's voice. */
  readonly hypothetical: string;
  /** A literal rendering of the passage believed to answer the question; text only, no address. */
  readonly quoted: string;
};

export type Origin = "question" | "topic" | "hypothetical" | "quoted";

export type Candidate = {
  readonly id: string;
  readonly address: string;
  readonly text: string;
  /** Which shape produced it first — the trace shows the query, not just the hit. */
  readonly origin: Origin;
};

export type QueryPlan = { readonly query: string; readonly origin: Origin };

export type Retrieve = (query: string, k: number) => Promise<readonly Candidate[]>;

/**
 * Every query the stage will run, in a deterministic order: the original question always
 * first (it is the user's own wording and must never be replaced), then the shapes. A query
 * repeated across shapes runs once and keeps the origin that introduced it.
 */
export function queriesFor(question: string, shapes: QueryShapes): QueryPlan[] {
  const candidates: QueryPlan[] = [
    { query: question, origin: "question" },
    ...shapes.topics.map((query) => ({ query, origin: "topic" as const })),
    { query: shapes.hypothetical, origin: "hypothetical" },
    { query: shapes.quoted, origin: "quoted" },
  ];
  const seen = new Set<string>();
  const plans: QueryPlan[] = [];
  for (const { query, origin } of candidates) {
    const trimmed = query.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    plans.push({ query: trimmed, origin });
  }
  return plans;
}

/**
 * Retrieve for every query and union by row id, keeping the origin that surfaced a row first.
 *
 * Order matters for provenance only: the caller reranks the union, so a candidate's position
 * in this array is not a ranking claim.
 */
export async function unionCandidates(
  question: string,
  shapes: QueryShapes,
  retrieve: Retrieve,
  k: number,
): Promise<Candidate[]> {
  const union = new Map<string, Candidate>();
  for (const { query, origin } of queriesFor(question, shapes)) {
    for (const candidate of await retrieve(query, k)) {
      if (!union.has(candidate.id)) union.set(candidate.id, { ...candidate, origin });
    }
  }
  return [...union.values()];
}

/** How many distinct rows each shape contributed first, for the trace and the tests. */
export function provenance(candidates: readonly Candidate[]): Record<Origin, number> {
  const counts: Record<Origin, number> = {
    question: 0,
    topic: 0,
    hypothetical: 0,
    quoted: 0,
  };
  for (const candidate of candidates) counts[candidate.origin] += 1;
  return counts;
}
