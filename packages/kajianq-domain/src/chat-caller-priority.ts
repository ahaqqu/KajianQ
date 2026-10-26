import type { TraceEvent } from "@app/contracts";
import type { Chunk } from "@app/rag-core";
import { compareTrackHits, type TrackHit } from "./chat-fusion";
import { admitSubQueryText } from "./chat-subquery-admission";

/**
 * Caller-query priority (ADR-0062): the caller's own question is the one query
 * guaranteed to be phrased in the user's vocabulary, so its leading dense hits
 * are a retrieval angle of their own. Fusion weighs every list alike, and the
 * router's paraphrases outnumber the caller's single list, so mid-rank
 * paraphrase rows can outscore the caller's leading row. This arm takes that
 * list's top hits and puts them at the front of the returned set under their
 * own provenance label; the label then keeps them out of the rerank's reorder,
 * and the assembler leads its presentation slot with them — the guarantee is
 * the three seams together, not the returned array alone.
 *
 * It reads nothing and adds nothing: the caller's sub-query was embedded and
 * searched by the ordinary fan-out, and fusion keeps every row it returned, so
 * this module promotes rows the returned set already holds. A caller hit absent
 * from that set is a broken invariant, recorded on the trace rather than
 * repaired by fabricating a chunk with no fused score. The bound is the
 * retriever's `callerPriorityK`, defaulting to the contract's `CALLER_PRIORITY_K`.
 *
 * The caller's entry is found by the text it carries, not by the origin that
 * offered it: the decomposition repair and the router's deterministic fallback
 * both copy the admitted verbatim question into their sub-query, and the
 * guarantee covers the caller's words whichever route wrote them down.
 */

/** The provenance label the caller's guaranteed chunks carry. It marks a row the
 * caller's own list produced, promoted ahead of its fusion rank — not a row
 * another path added. */
export const CALLER_PRIORITY_ORIGIN = "caller_priority";

/** One `caller_priority` record: the guaranteed set, its bound, and how much of
 * it the returned set already held. */
export type CallerPriorityDetail = {
  k: number;
  /** The guaranteed hits, in the caller list's ascending dense rank. */
  ids: string[];
  /** Of `ids`, the rows the returned set already carried. A shorter list names a
   * caller hit fusion never returned. */
  alreadyPresent: string[];
};

export type CallerPriority = {
  chunks: readonly Chunk[];
  /** Null when the route had no caller sub-query — nothing to record. */
  detail: CallerPriorityDetail | null;
};

/**
 * True for the sub-query carrying the caller's verbatim question. Two routes
 * can produce that entry — the decomposition repair's `factual` sub-query and
 * the router's deterministic fallback — and both copy the admitted question
 * into their entry's text, so the entry is found by the words it carries rather
 * than by the origin that offered it. The origin stays the entry's own on the
 * trace; only this selection is origin-blind.
 */
export function isCallerSubQuery(sub: { text: string }, callerText: string): boolean {
  const question = admitSubQueryText(callerText);
  return question !== undefined && sub.text === question;
}

/**
 * The caller's leading hits across its tracks: deduped by chunk id (a row both
 * tracks returned is one hit at its better rank), ordered by ascending dense
 * rank with ties broken by chunk id, at most `k`. Exported for the tests that
 * pin the ordering and the bound.
 */
export function callerPriorityHits(lists: readonly TrackHit[][], k: number): TrackHit[] {
  const byId = new Map<string, TrackHit>();
  for (const list of lists) {
    for (const hit of list) {
      const seen = byId.get(hit.chunk.id);
      if (seen === undefined || compareTrackHits(hit, seen) < 0) byId.set(hit.chunk.id, hit);
    }
  }
  return [...byId.values()].sort(compareTrackHits).slice(0, k);
}

/**
 * Move the caller's leading hits to the front of the returned set and label
 * them. A hit keeps its own chunk — text, metadata and any arm's more specific
 * label survive — and is promoted; a hit the set does not hold is left out of
 * the block and shows on the record as an id `alreadyPresent` does not name. No
 * duplicate is ever produced, and nothing is dropped: the rest of the set
 * follows in its order.
 */
export function guaranteeCallerPriority(input: {
  callerLists: readonly TrackHit[][];
  returned: readonly Chunk[];
  /** The bound the run applies: the retriever's knob, contract-bounded. */
  k: number;
}): CallerPriority {
  if (input.callerLists.length === 0) return { chunks: input.returned, detail: null };
  const hits = callerPriorityHits(input.callerLists, input.k);
  const held = new Map(input.returned.map((chunk) => [chunk.id, chunk]));
  const ids = hits.map((hit) => hit.chunk.id);
  const priority = hits.flatMap((hit) => {
    const existing = held.get(hit.chunk.id);
    return existing === undefined
      ? []
      : [{ ...existing, origin: existing.origin ?? CALLER_PRIORITY_ORIGIN }];
  });
  const guaranteed = new Set(ids);
  return {
    chunks: [...priority, ...input.returned.filter((chunk) => !guaranteed.has(chunk.id))],
    detail: {
      k: input.k,
      ids,
      alreadyPresent: ids.filter((id) => held.has(id)),
    },
  };
}

/**
 * The guarantee's one application site: promote the caller's leading hits and,
 * when the route had a caller list, record the typed event through the run's
 * sink. The retriever hands over its lists and its clock; nothing here reads a
 * store or calls a vendor.
 */
export function applyCallerPriority(input: {
  callerLists: readonly TrackHit[][];
  returned: readonly Chunk[];
  k: number;
  at: number;
  record: (event: TraceEvent) => void;
}): readonly Chunk[] {
  const priority = guaranteeCallerPriority({
    callerLists: input.callerLists,
    returned: input.returned,
    k: input.k,
  });
  if (priority.detail !== null) {
    input.record({
      stage: "retriever",
      kind: "caller_priority",
      detail: priority.detail,
      at: input.at,
    });
  }
  return priority.chunks;
}
