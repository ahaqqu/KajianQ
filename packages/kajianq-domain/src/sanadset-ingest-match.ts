/**
 * Where a Sanadset matn group attaches in the existing corpus.
 *
 * The stored children this index reconciles against are the v1 hadith rows, and
 * their `text_raw` is the API edition's whole narration — isnad then matn. A
 * Sanadset matn is therefore one part of a stored child, not a child: comparing
 * the matn's trigrams to the narration's as a Jaccard set measures the isnad's
 * extra length, not the report. The index compares like units twice:
 *
 * - exact and folded text first, for a stored child that *is* the matn;
 * - then a candidate score that takes the higher of trigram Jaccard (a
 *   near-identical text) and containment — the share of the matn's trigrams the
 *   stored text holds — so a matn wholly present inside a longer narration scores
 *   at or above the auto threshold instead of reading as a new child.
 *
 * Containment alone cannot tell a report from a phrase quoted inside another one:
 * a generic formula appears verbatim in a long, unrelated narration, and every
 * trigram of it is present there. A fuzzy target is therefore admitted only when
 * the containment relation holds as a relation of texts, not merely of trigram
 * sets: the matn must be long enough to be a report, most of its tokens must occur
 * in the child, those tokens must sit inside a window close to the matn's own
 * length, and the stored narration must not be many times longer than the matn.
 * A pair that fails one of those tests is a fragment; the group is quarantined
 * with the reason rather than attached to the narration that happens to quote it.
 *
 * Candidates come from rare-token postings rather than MinHash bands. At the
 * containment ratio a narration/matn pair carries, a band signature misses most
 * true pairs (the isnad's trigrams dominate it), while every token of a matn that
 * is present in the child is in that child's token list. The three rarest query
 * tokens with postings are unioned, so one spelling the fold does not settle
 * still leaves two candidate keys, and the cap turns bounded recall into a
 * reported refusal rather than a guess.
 *
 * What the index refuses to do is choose on a coin flip. Two children at the top
 * score within the ambiguity margin, two children carrying the same text, a
 * candidate search that hit its cap, and a containment that failed the fragment
 * tests are each reported rather than resolved: the group is quarantined, because
 * an arbitrary target would put a chain on the wrong narration and nothing later
 * would notice.
 */

import { MAX_CANDIDATES_PER_ROW } from "./sanadset-blocking";
import {
  containmentEvidence,
  containmentRefusal,
  tokenSequence,
  tokensOf,
  type EvidenceChild,
} from "./sanadset-ingest-fragment";
import { jaccard, matnTrigrams, normalizeMatnText } from "./sanadset-text";

/** The fragment guards live with the evidence they measure; the matcher is their consumer. */
export {
  MAX_MATCH_WINDOW_RATIO,
  MAX_NARRATION_MATN_CHAR_RATIO,
  MIN_CONTAINMENT_CHARS,
  MIN_CONTAINMENT_TOKENS,
  MIN_TOKEN_COVERAGE,
} from "./sanadset-ingest-fragment";

/** How many rare query tokens seed the candidate search. */
export const CANDIDATE_TOKENS = 3;

/** A prepared row, reduced to what the matcher reads. */
export type MatnQueryRow = {
  readonly rawMatn: string;
  readonly normalizedMatn: string;
  readonly trigrams: readonly string[];
};

/** One stored child the corpus read returned: its id, its immutable text, its collection. */
export type ExistingChildRow = {
  readonly id: string;
  readonly textRaw: string;
  readonly collection: string;
};

/** Where one group belongs, or why the index will not place it. */
export type MatnTarget =
  | {
      readonly kind: "existing";
      readonly childId: string;
      /** `containment` means the matn was found inside a longer stored narration. */
      readonly how: "exact" | "folded" | "trigram" | "containment";
      readonly score: number;
    }
  | { readonly kind: "new" }
  | { readonly kind: "ambiguous"; readonly score: number; readonly candidates: readonly string[] }
  /** A candidate scored above the threshold, but only as a fragment of its narration. */
  | {
      readonly kind: "fragmentary";
      readonly childId: string;
      readonly score: number;
      readonly how: "trigram" | "containment";
      /** Which containment test failed and the measured value, in operator terms. */
      readonly reason: string;
    }
  /** The candidate search hit its cap: recall was bounded, so no target is claimed. */
  | { readonly kind: "truncated"; readonly candidates: number; readonly cap: number };

export type ChildMatchIndex = {
  readonly size: number;
  /** How many children the read supplied for the collection (never another's). */
  readonly collectionChildren: number;
  /** Groups whose candidate search hit the cap: recall was bounded, not exact. */
  readonly truncatedSearches: () => number;
  match(row: MatnQueryRow): MatnTarget;
};

export type ChildMatchOptions = {
  /** The v1 collection key (`bukhari`); a child of any other collection is ignored. */
  readonly collection: string;
  readonly autoThreshold: number;
  readonly ambiguityMargin: number;
};

type IndexedChild = EvidenceChild & {
  readonly child: ExistingChildRow;
  readonly trigrams: readonly string[];
  readonly trigramSet: ReadonlySet<string>;
};

/** A candidate at the top of the score list, used for the ambiguity rule. */
type Scored = {
  readonly id: string;
  readonly score: number;
  readonly how: "trigram" | "containment";
};

function pushTo(map: Map<string, string[]>, key: string, id: string): void {
  if (key === "") return;
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [id]);
  else bucket.push(id);
}

/** The one target for a bucket of equally good children: none, one, or ambiguous. */
function targetForBucket(
  bucket: readonly string[] | undefined,
  how: "exact" | "folded",
): MatnTarget | null {
  if (bucket === undefined || bucket.length === 0) return null;
  if (bucket.length === 1) return { kind: "existing", childId: bucket[0] as string, how, score: 1 };
  return { kind: "ambiguous", score: 1, candidates: [...bucket].sort() };
}

export function createChildMatchIndex(
  children: readonly ExistingChildRow[],
  options: ChildMatchOptions,
): ChildMatchIndex {
  const byId = new Map<string, IndexedChild>();
  const exact = new Map<string, string[]>();
  const folded = new Map<string, string[]>();
  const postings = new Map<string, string[]>();
  let truncatedSearches = 0;

  for (const child of children) {
    if (child.collection !== options.collection) continue;
    const normalized = normalizeMatnText(child.textRaw);
    const trigrams = matnTrigrams(normalized);
    const sequence = tokenSequence(normalized);
    const indexed: IndexedChild = {
      child,
      normalized,
      trigrams,
      trigramSet: new Set(trigrams),
      tokenSequence: sequence,
      tokenSet: new Set(sequence),
    };
    byId.set(child.id, indexed);
    pushTo(exact, child.textRaw, child.id);
    pushTo(folded, normalized, child.id);
    for (const token of new Set(sequence)) pushTo(postings, token, child.id);
  }

  const match = (row: MatnQueryRow): MatnTarget => {
    const exactTarget = targetForBucket(exact.get(row.rawMatn), "exact");
    if (exactTarget !== null) return exactTarget;
    const foldedTarget = targetForBucket(folded.get(row.normalizedMatn), "folded");
    if (foldedTarget !== null) return foldedTarget;

    const queryTokens = tokensOf(row.normalizedMatn);
    // Seed the search from the rarest tokens the matn carries: a matn present in
    // the narration shares every token with it, so one of these postings holds the
    // child, while a common token would return half the corpus for no gain.
    const ranked = queryTokens
      .map((token) => ({ token, ids: postings.get(token) }))
      .filter((entry): entry is { token: string; ids: string[] } => entry.ids !== undefined)
      .sort(
        (left, right) =>
          left.ids.length - right.ids.length || left.token.localeCompare(right.token),
      )
      .slice(0, CANDIDATE_TOKENS);

    const candidateIds = new Set<string>();
    let capped = false;
    for (const { ids } of ranked) {
      for (const id of ids) {
        if (candidateIds.has(id)) continue;
        if (candidateIds.size >= MAX_CANDIDATES_PER_ROW) {
          capped = true;
          break;
        }
        candidateIds.add(id);
      }
      if (capped) break;
    }
    if (capped) {
      truncatedSearches += 1;
      return { kind: "truncated", candidates: candidateIds.size, cap: MAX_CANDIDATES_PER_ROW };
    }

    const querySet = new Set(row.trigrams);
    const scored: Scored[] = [];
    for (const id of candidateIds) {
      const candidate = byId.get(id);
      if (candidate === undefined) continue;
      const jac = jaccard(row.trigrams, candidate.trigrams);
      let shared = 0;
      for (const trigram of querySet) if (candidate.trigramSet.has(trigram)) shared += 1;
      const containment = querySet.size === 0 ? 0 : shared / querySet.size;
      const score = Math.max(jac, containment);
      if (score <= 0) continue;
      scored.push({ id, score, how: containment > jac ? "containment" : "trigram" });
    }
    scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    const top = scored[0];
    if (top === undefined || top.score < options.autoThreshold) return { kind: "new" };

    const candidate = byId.get(top.id) as IndexedChild;
    const evidence = containmentEvidence(queryTokens, candidate);
    const refusal = containmentRefusal(row.normalizedMatn, queryTokens, evidence, candidate);
    if (refusal !== null) {
      return {
        kind: "fragmentary",
        childId: top.id,
        score: top.score,
        how: top.how,
        reason: refusal,
      };
    }

    const second = scored[1];
    if (second !== undefined && top.score - second.score <= options.ambiguityMargin) {
      const runnerUp = byId.get(second.id) as IndexedChild;
      const runnerUpRefusal = containmentRefusal(
        row.normalizedMatn,
        queryTokens,
        containmentEvidence(queryTokens, runnerUp),
        runnerUp,
      );
      // A fragment cannot be the competing target, so it does not create doubt.
      if (runnerUpRefusal === null) {
        return {
          kind: "ambiguous",
          score: top.score,
          candidates: [top.id, second.id].sort(),
        };
      }
    }
    return { kind: "existing", childId: top.id, how: top.how, score: top.score };
  };

  return {
    size: byId.size,
    collectionChildren: byId.size,
    truncatedSearches: () => truncatedSearches,
    match,
  };
}
