import type { ChunkRefLike, RetrievalLike, TraceEventLike } from "./harness-types";

/**
 * Deterministic scorers (#8, spec §3.7): retrieval recall, citation validity,
 * and refusal correctness. No LLM involvement — the metrics the spec marks
 * "deterministic" come from persisted traces and the answer text alone.
 */

/**
 * Retrieval recall: the fraction of the question's expected source types that
 * appear among the retrieval event's retrieved chunks (by chunk metadata's
 * `sourceType` value, read from the trace's chunk refs' stored metadata when
 * the caller can join it, or from the ref ids when the caller pre-joins).
 *
 * The harness passes the retrieval event plus a resolver that maps a chunk
 * id to its source-type label; the trace itself carries only ids (ADR-0007),
 * so the join is the caller's knowledge, not a re-parse.
 */
export function retrievalRecall(
  expectedSourceTypes: readonly string[],
  retrieved: readonly ChunkRefLike[],
  sourceTypeOf: (chunkId: string) => string | undefined,
): number {
  if (expectedSourceTypes.length === 0) return 1;
  const hit = new Set(
    expectedSourceTypes.filter((t) => retrieved.some((c) => sourceTypeOf(c.id) === t)),
  );
  return hit.size / expectedSourceTypes.length;
}

/**
 * Citation validity: the fraction of the question's required citations that
 * appear verbatim in the answer text. A question with no required citations
 * scores 1 (nothing to violate).
 */
export function citationValidity(requiredCitations: readonly string[], answerText: string): number {
  if (requiredCitations.length === 0) return 1;
  const present = requiredCitations.filter((c) => answerText.includes(c)).length;
  return present / requiredCitations.length;
}

/**
 * Refusal correctness: did the pipeline's observable behavior match the
 * question's expectation? A refusal is detected from the trace's `refusal`
 * event or a refusal-marker in the text (exact markers come from the caller —
 * the engine stays language-agnostic).
 */
export function refusalCorrectness(
  expectedBehavior: "answer" | "refuse",
  refused: boolean,
): boolean {
  return expectedBehavior === "refuse" ? refused : !refused;
}

/**
 * Refusal detection over one run's trace events: true when any stage recorded
 * a `refusal` event, or when the answer text matches one of the caller's
 * refusal markers.
 */
export function detectRefusal(
  events: readonly TraceEventLike[],
  answerText: string,
  refusalMarkers: readonly string[],
): boolean {
  if (events.some((e) => e.kind === "refusal")) return true;
  return refusalMarkers.some((m) => m !== "" && answerText.includes(m));
}

/** The retrieval events of one trace, in order. */
export function retrievalEventsOf(trace: { events: RetrievalLike[] }): RetrievalLike[] {
  return trace.events.filter((e) => e.kind === "retrieval");
}
