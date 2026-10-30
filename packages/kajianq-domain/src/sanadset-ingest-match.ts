/**
 * Where a Sanadset matn group attaches in the existing corpus.
 *
 * The index answers one question per group: which stored child of the **same
 * collection** holds this matn, under the deterministic cascade the study
 * pre-registered — exact text, then folded text, then trigram Jaccard at or above
 * the auto threshold. It never proposes a child of another collection: a Bukhari
 * matn is evidence about a Bukhari child, and a text that coincides across two
 * works is two children (the book scope the cascade applies to its own groups).
 *
 * What the index refuses to do is choose on a coin flip. Two children at the top
 * score within the ambiguity margin, two children carrying the same text, and a
 * truncated candidate search are each reported rather than resolved: the group is
 * quarantined as an ambiguous best match, because an arbitrary target would put a
 * chain on the wrong narration and nothing later would notice.
 */

import {
  addToLshIndex,
  lshBandKeys,
  minhashSignature,
  searchLshIndex,
  type LshIndex,
} from "./sanadset-blocking";
import { jaccard, matnTrigrams, normalizeMatnText } from "./sanadset-text";

/** A prepared row, reduced to what the matcher reads. */
export type MatnQueryRow = {
  readonly rawMatn: string;
  readonly normalizedMatn: string;
  readonly trigrams: readonly string[];
  readonly bandKeys: readonly string[];
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
      readonly how: "exact" | "folded" | "trigram";
      readonly score: number;
    }
  | { readonly kind: "new" }
  | { readonly kind: "ambiguous"; readonly score: number; readonly candidates: readonly string[] };

export type ChildMatchIndex = {
  readonly size: number;
  /** How many children the read supplied for the collection (never another's). */
  readonly collectionChildren: number;
  /** Groups whose trigram search hit the candidate cap: recall was bounded, not exact. */
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
};

/** A candidate at the top of the score list, used for the ambiguity rule. */
type Scored = { readonly id: string; readonly score: number };

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
  const index: LshIndex<IndexedChild> = new Map();
  let truncatedSearches = 0;

  for (const child of children) {
    if (child.collection !== options.collection) continue;
    const normalized = normalizeMatnText(child.textRaw);
    const trigrams = matnTrigrams(normalized);
    const indexed: IndexedChild = { child, normalized, trigrams };
    byId.set(child.id, indexed);
    pushTo(exact, child.textRaw, child.id);
    pushTo(folded, normalized, child.id);
    if (normalized !== "") addToLshIndex(index, lshBandKeys(minhashSignature(trigrams)), indexed);
  }

  const match = (row: MatnQueryRow): MatnTarget => {
    const exactTarget = targetForBucket(exact.get(row.rawMatn), "exact");
    if (exactTarget !== null) return exactTarget;
    const foldedTarget = targetForBucket(folded.get(row.normalizedMatn), "folded");
    if (foldedTarget !== null) return foldedTarget;

    const searched = searchLshIndex(index, row.bandKeys);
    if (searched.truncated) truncatedSearches += 1;
    const scored: Scored[] = [];
    for (const candidate of searched.values) {
      const score = jaccard(row.trigrams, candidate.trigrams);
      if (score <= 0) continue;
      scored.push({ id: candidate.child.id, score });
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
    return { kind: "existing", childId: top.id, how: "trigram", score: top.score };
  };

  return {
    size: byId.size,
    collectionChildren: byId.size,
    truncatedSearches: () => truncatedSearches,
    match,
  };
}
