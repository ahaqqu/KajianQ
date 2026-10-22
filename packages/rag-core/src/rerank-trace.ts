import { Cause } from "effect";
import type { Chunk } from "./pipeline";
import type { RunContextService } from "./context";
import { ProviderError } from "./provider";
import type { CostRecord, TraceEvent } from "@app/contracts";

/**
 * The rerank's trace records, split from the ranking so the ordering module
 * stays under the seam cap and this one carries the event shape.
 */

/** The rerank event's detail, taken from the contract rather than restated. */
export type RerankDetail = Extract<TraceEvent, { kind: "rerank" }>["detail"];

/** Per-candidate trace items, in request order. */
export function rerankItems(
  candidates: readonly Chunk[],
  probabilities?: readonly number[],
  rankAfter?: readonly number[],
): RerankDetail["items"] {
  return candidates.map((candidate, index) => {
    const probability = probabilities?.[index];
    const rank = rankAfter?.[index];
    return {
      index,
      key: candidate.id,
      ...(candidate.score !== undefined ? { fusedScore: candidate.score } : {}),
      ...(probability !== undefined ? { rerankScore: probability } : {}),
      ...(rank !== undefined ? { rankAfter: rank } : {}),
    };
  });
}

/** Record the ranking event; the call's spend rides on its own `llm_call`. */
export function recordRerank(
  run: Pick<RunContextService, "now" | "record">,
  purpose: string,
  detail: Omit<RerankDetail, "purpose">,
): void {
  run.record({
    stage: "retriever",
    kind: "rerank",
    detail: { purpose, ...detail },
    at: run.now(),
  });
}

/** True when a sandboxed cause is a cancellation only — never fail open on it. */
export function isCancellation(cause: Parameters<typeof Cause.squash>[0]): boolean {
  return Cause.hasInterruptsOnly(cause);
}

/**
 * Record every attempt cost a failed decision call carries — a retry or
 * fallback that reached the vendor spent real tokens even though it failed.
 */
export function recordRerankAttemptCosts(
  run: Pick<RunContextService, "now" | "record">,
  purpose: string,
  cause: Parameters<typeof Cause.squash>[0],
): void {
  const failure = Cause.squash(cause);
  if (!(failure instanceof ProviderError)) return;
  for (const attempt of failure.attemptCosts ?? []) {
    recordRerankCall(run, purpose, attempt);
  }
}

/** Record one decision call's spend, a failed attempt's estimate included. */
export function recordRerankCall(
  run: Pick<RunContextService, "now" | "record">,
  purpose: string,
  cost: CostRecord,
): void {
  run.record({
    stage: "retriever",
    kind: "llm_call",
    detail: { purpose },
    cost,
    at: run.now(),
  });
}
