import { CALLER_PRIORITY_K } from "@app/contracts";
import type { Chunk } from "@app/rag-core";
import { compareTrackHits, type TrackHit } from "./chat-fusion";

/**
 * Caller-query priority (ADR-0062): the caller's own question is the one query
 * guaranteed to be phrased in the user's vocabulary, so its leading dense hits
 * are a retrieval angle of their own. Fusion weighs every list alike, and the
 * router's paraphrases outnumber the caller's single list, so mid-rank
 * paraphrase rows can outscore the caller's leading row. This arm takes that
 * list's top hits and puts them at the front of the returned set under their
 * own provenance label — the label is what keeps the rerank from reordering
 * them away, because a labelled chunk keeps the position the retriever gave it.
 *
 * It reads nothing: the caller's sub-query was embedded and searched by the
 * ordinary fan-out, and this module only selects from the lists that search
 * already returned. The bound is the contract's `CALLER_PRIORITY_K`.
 */

/** What produced the caller's sub-query, as the decomposition repair labels it. */
export const CALLER_QUERY_ORIGIN = "rule";

/** The role the caller's sub-query carries, as the decomposition repair labels it. */
export const CALLER_QUERY_ROLE = "factual";

/** The provenance label the caller's guaranteed chunks carry. Fused hits leave
 * `origin` unset, so a trace reader can tell this angle from the ordinary vote. */
export const CALLER_PRIORITY_ORIGIN = "caller_priority";

/** One `caller_priority` record: the guaranteed set, its bound, and how much of
 * it the returned set already held. */
export type CallerPriorityDetail = {
  k: number;
  /** The guaranteed hits, in the caller list's ascending dense rank. */
  ids: string[];
  /** Of `ids`, the rows the returned set already carried. */
  alreadyPresent: string[];
};

export type CallerPriority = {
  chunks: readonly Chunk[];
  /** Null when the route had no caller sub-query — nothing to record. */
  detail: CallerPriorityDetail | null;
};

/**
 * True for the sub-query the decomposition repair made from the caller's
 * verbatim question. The repair guarantees it is the set's first entry, so the
 * retriever can find it by its labels rather than by its position.
 */
export function isCallerSubQuery(sub: { role?: string; origin?: string }): boolean {
  return sub.origin === CALLER_QUERY_ORIGIN && sub.role === CALLER_QUERY_ROLE;
}

/**
 * The caller's leading hits across its tracks: deduped by chunk id (a row both
 * tracks returned is one hit at its better rank), ordered by ascending dense
 * rank with ties broken by chunk id, at most `CALLER_PRIORITY_K`. Exported for
 * the tests that pin the ordering and the bound.
 */
export function callerPriorityHits(lists: readonly TrackHit[][]): TrackHit[] {
  const byId = new Map<string, TrackHit>();
  for (const list of lists) {
    for (const hit of list) {
      const seen = byId.get(hit.chunk.id);
      if (seen === undefined || compareTrackHits(hit, seen) < 0) byId.set(hit.chunk.id, hit);
    }
  }
  return [...byId.values()].sort(compareTrackHits).slice(0, CALLER_PRIORITY_K);
}

/**
 * Put the caller's leading hits at the front of the returned set and label
 * them. A hit the set already holds keeps its own chunk — text, metadata and
 * any arm's more specific label survive — and is moved to the priority block; a
 * hit it does not hold is added from the caller's search. No duplicate is ever
 * produced, and nothing is dropped: the rest of the set follows in its order.
 */
export function guaranteeCallerPriority(input: {
  callerLists: readonly TrackHit[][];
  returned: readonly Chunk[];
}): CallerPriority {
  if (input.callerLists.length === 0) return { chunks: input.returned, detail: null };
  const hits = callerPriorityHits(input.callerLists);
  const held = new Map(input.returned.map((chunk) => [chunk.id, chunk]));
  const ids = hits.map((hit) => hit.chunk.id);
  const priority = hits.map((hit) => {
    const existing = held.get(hit.chunk.id);
    if (existing === undefined) return { ...hit.chunk, origin: CALLER_PRIORITY_ORIGIN };
    return { ...existing, origin: existing.origin ?? CALLER_PRIORITY_ORIGIN };
  });
  const guaranteed = new Set(ids);
  return {
    chunks: [...priority, ...input.returned.filter((chunk) => !guaranteed.has(chunk.id))],
    detail: {
      k: CALLER_PRIORITY_K,
      ids,
      alreadyPresent: ids.filter((id) => held.has(id)),
    },
  };
}
