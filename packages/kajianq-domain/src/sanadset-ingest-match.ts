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
 * Candidates come from rare-token postings rather than MinHash bands. At the
 * containment ratio a narration/matn pair carries, a band signature misses most
 * true pairs (the isnad's trigrams dominate it), while every token of a matn that
 * is present in the child is in that child's token list. The three rarest query
 * tokens with postings are unioned, so one spelling the fold does not settle
 * still leaves two candidate keys, and the cap turns bounded recall into a
 * reported refusal rather than a guess.
 *
 * What the index refuses to do is choose on a coin flip. Two children at the top
 * score within the ambiguity margin, two children carrying the same text, and a
 * candidate search that hit its cap are each reported rather than resolved: the
 * group is quarantined, because an arbitrary target would put a chain on the
 * wrong narration and nothing later would notice.
 */

import { MAX_CANDIDATES_PER_ROW } from "./sanadset-blocking";
import { jaccard, matnTrigrams, normalizeMatnText } from "./sanadset-text";

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

type IndexedChild = {
  readonly child: ExistingChildRow;
  readonly normalized: string;
  readonly trigrams: readonly string[];
  readonly trigramSet: ReadonlySet<string>;
  readonly tokens: readonly string[];
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

/** The distinct folded tokens of a normalized text, in text order. */
function tokensOf(normalized: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of normalized.split(" ")) {
    if (token === "" || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
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
    const indexed: IndexedChild = {
      child,
      normalized,
      trigrams,
      trigramSet: new Set(trigrams),
      tokens: tokensOf(normalized),
    };
    byId.set(child.id, indexed);
    pushTo(exact, child.textRaw, child.id);
    pushTo(folded, normalized, child.id);
    for (const token of indexed.tokens) pushTo(postings, token, child.id);
  }

  const match = (row: MatnQueryRow): MatnTarget => {
    const exactTarget = targetForBucket(exact.get(row.rawMatn), "exact");
    if (exactTarget !== null) return exactTarget;
    const foldedTarget = targetForBucket(folded.get(row.normalizedMatn), "folded");
    if (foldedTarget !== null) return foldedTarget;

    // Seed the search from the rarest tokens the matn carries: a matn present in
    // the narration shares every token with it, so one of these postings holds the
    // child, while a common token would return half the corpus for no gain.
    const ranked = tokensOf(row.normalizedMatn)
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
    const second = scored[1];
    if (second !== undefined && top.score - second.score <= options.ambiguityMargin) {
      return {
        kind: "ambiguous",
        score: top.score,
        candidates: [top.id, second.id].sort(),
      };
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
