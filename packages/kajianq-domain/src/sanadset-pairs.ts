/**
 * Candidate pair generation for the pre-registered blind sample.
 *
 * The sample is an instrument, not a showcase: each stratum is drawn from the
 * population that makes the arm's failure mode visible. `fold_same` shows whether the
 * fold over-merges, `blocking_same` is the band the model actually decides, and
 * `singleton` is the blocking key's false negative — two rare names the deterministic
 * pass never compares. The matn strata mirror that: exact, inside the band, and below
 * the band where the cascade already says "no match".
 *
 * The matn pass is deliberately independent of the cascade and issues no model call, so
 * the whole sample can be drawn and written before any model output exists.
 */

import {
  addToLshIndex,
  narratorBlockingKey,
  searchLshIndex,
  type LshIndex,
} from "./sanadset-blocking";
import { representativeSurface, singletonNames, type NarratorCatalogue } from "./sanadset-narrator";
import type { PreparedRow } from "./sanadset-prepare";
import { jaccard } from "./sanadset-text";

export type PairKind = "narrator" | "matn";

export type PairStratum =
  | "narrator_fold_same"
  | "narrator_blocking_same"
  | "narrator_singleton"
  | "matn_exact"
  | "matn_near_duplicate"
  | "matn_false_friend";

export const NARRATOR_STRATA = [
  "narrator_fold_same",
  "narrator_blocking_same",
  "narrator_singleton",
] as const satisfies readonly PairStratum[];

export const MATN_STRATA = [
  "matn_exact",
  "matn_near_duplicate",
  "matn_false_friend",
] as const satisfies readonly PairStratum[];

/**
 * Matn pair bands, in the same score space the cascade uses. `near_duplicate` starts at
 * the model-band floor and has no upper bound below raw equality, so the stratum also
 * holds the pairs the cascade merged without asking anyone: auditing the auto threshold
 * is the point, and a sample that only held the band could not do it.
 */
export const MATN_EXACT_SCORE = 1;
export const MATN_NEAR_DUPLICATE_MIN = 0.6;
export const MATN_FALSE_FRIEND_MIN = 0.25;
export const MATN_FALSE_FRIEND_MAX = 0.6;
/** Token-set Jaccard floor for a singleton name pair the blocking key never compared. */
export const SINGLETON_TOKEN_JACCARD_FLOOR = 0.5;
/** Per-stratum candidate cap; the cap only bounds work, the seeded draw decides the sample. */
export const MAX_CANDIDATES_PER_STRATUM = 4000;
const MAX_NAMES_PER_GROUP = 64;
const MAX_SINGLETONS_PER_TOKEN = 64;

export type StudyPairRef = {
  /** Source record of the first side, when the pair came from two rows. */
  readonly rowA: number | null;
  readonly rowB: number | null;
  /** The deterministic lexical score, when one exists; never shown to the arm or the owner. */
  readonly score: number | null;
};

export type StudyPair = {
  readonly kind: PairKind;
  readonly stratum: PairStratum;
  readonly a: string;
  readonly b: string;
  readonly ref: StudyPairRef;
};

export type PairCandidates = Map<PairStratum, StudyPair[]>;

function push(pool: PairCandidates, stratum: PairStratum, pair: StudyPair): boolean {
  const bucket = pool.get(stratum);
  if (bucket === undefined) {
    pool.set(stratum, [pair]);
    return true;
  }
  if (bucket.length >= MAX_CANDIDATES_PER_STRATUM) return false;
  bucket.push(pair);
  return true;
}

function pairKey(a: string, b: string): string {
  return a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function tokenSet(text: string): Set<string> {
  return new Set(text.split(" ").filter((token) => token.length > 0));
}

function tokenJaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Narrator candidates: folded variants, then blocking-key collisions, then singleton
 * pairs that share enough tokens to be a plausible identity question.
 */
export function buildNarratorPairCandidates(catalogue: NarratorCatalogue): PairCandidates {
  const pool: PairCandidates = new Map();

  for (const folded of [...catalogue.clusters.keys()].sort()) {
    const surfaces = catalogue.clusters.get(folded)?.surfaces ?? [];
    if (surfaces.length < 2) continue;
    push(pool, "narrator_fold_same", {
      kind: "narrator",
      stratum: "narrator_fold_same",
      a: surfaces[0] as string,
      b: surfaces[1] as string,
      ref: { rowA: null, rowB: null, score: null },
    });
  }

  for (const key of [...catalogue.blockingGroups.keys()].sort()) {
    const names = (catalogue.blockingGroups.get(key) ?? []).slice(0, MAX_NAMES_PER_GROUP);
    if (names.length < 2) continue;
    for (let i = 0; i + 1 < names.length; i += 2) {
      const left = representativeSurface(catalogue, names[i] as string);
      const right = representativeSurface(catalogue, names[i + 1] as string);
      if (left === null || right === null) continue;
      push(pool, "narrator_blocking_same", {
        kind: "narrator",
        stratum: "narrator_blocking_same",
        a: left,
        b: right,
        ref: { rowA: null, rowB: null, score: null },
      });
    }
  }

  const singletons = singletonNames(catalogue);
  const byToken = new Map<string, string[]>();
  for (const name of singletons) {
    for (const token of tokenSet(name)) {
      const bucket = byToken.get(token);
      if (bucket === undefined) byToken.set(token, [name]);
      else if (bucket.length < MAX_SINGLETONS_PER_TOKEN) bucket.push(name);
    }
  }
  const seen = new Set<string>();
  for (const name of singletons) {
    const foldedTokens = tokenSet(name);
    for (const token of foldedTokens) {
      for (const other of byToken.get(token) ?? []) {
        if (other === name) continue;
        const key = pairKey(name, other);
        if (seen.has(key)) continue;
        seen.add(key);
        if (narratorBlockingKey(name) === narratorBlockingKey(other)) continue;
        if (tokenJaccard(foldedTokens, tokenSet(other)) < SINGLETON_TOKEN_JACCARD_FLOOR) continue;
        const left = representativeSurface(catalogue, name);
        const right = representativeSurface(catalogue, other);
        if (left === null || right === null) continue;
        const ordered = name <= other ? [left, right] : [right, left];
        push(pool, "narrator_singleton", {
          kind: "narrator",
          stratum: "narrator_singleton",
          a: ordered[0] as string,
          b: ordered[1] as string,
          ref: { rowA: null, rowB: null, score: null },
        });
      }
    }
  }

  return pool;
}

/**
 * Matn candidates over the prepared slice: the exact duplicates, the band, and the
 * near-misses below it. Every candidate is scored against earlier rows only, so the
 * pass is deterministic and a pair appears once.
 */
export function buildMatnPairCandidates(rows: readonly PreparedRow[]): PairCandidates {
  const pool: PairCandidates = new Map();
  const seen = new Set<string>();
  const firstByRaw = new Map<string, PreparedRow>();
  const byRowIndex = new Map<number, PreparedRow>();
  const index: LshIndex<{ readonly rowIndex: number }> = new Map();

  for (const row of rows) {
    const first = firstByRaw.get(row.rawMatn);
    if (first !== undefined) {
      const key = pairKey(first.rawMatn, row.rawMatn);
      if (!seen.has(key)) {
        seen.add(key);
        push(pool, "matn_exact", {
          kind: "matn",
          stratum: "matn_exact",
          a: first.rawMatn,
          b: row.rawMatn,
          ref: { rowA: first.rowIndex, rowB: row.rowIndex, score: MATN_EXACT_SCORE },
        });
      }
    } else {
      firstByRaw.set(row.rawMatn, row);
    }

    const found = searchLshIndex(index, row.bandKeys);
    for (const member of found.values) {
      const other = byRowIndex.get(member.rowIndex);
      if (other === undefined) continue;
      const key = pairKey(other.rawMatn, row.rawMatn);
      if (seen.has(key)) continue;
      const score = jaccard(row.trigrams, other.trigrams);
      const stratum =
        score >= MATN_NEAR_DUPLICATE_MIN
          ? ("matn_near_duplicate" as const)
          : score >= MATN_FALSE_FRIEND_MIN && score < MATN_FALSE_FRIEND_MAX
            ? ("matn_false_friend" as const)
            : null;
      if (stratum === null) continue;
      seen.add(key);
      push(pool, stratum, {
        kind: "matn",
        stratum,
        a: other.rawMatn,
        b: row.rawMatn,
        ref: { rowA: other.rowIndex, rowB: row.rowIndex, score },
      });
    }

    addToLshIndex(index, row.bandKeys, { rowIndex: row.rowIndex });
    byRowIndex.set(row.rowIndex, row);
  }

  return pool;
}
