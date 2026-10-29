/**
 * Blocking for the two reconciliation targets.
 *
 * Narrator names block on the token-sorted key of the folded tokens minus nasab
 * particles, as the study pre-registers: two names that survive the fold but not
 * this key are a candidate identity pair, never an automatic merge.
 *
 * Matn texts block on a MinHash LSH index over their character trigrams. The index
 * only proposes candidate pairs; the exact Jaccard score decides them, so a missed
 * bucket costs recall (reported) rather than a forced match.
 */

/** Number of MinHash permutations per matn signature. */
export const SIGNATURE_LENGTH = 96;
/** Bands and rows per band: 24 bands of 4 hashes are 96 permutations. */
export const LSH_BANDS = 24;
export const LSH_ROWS = 4;
/** Per-row candidate cap: bounds a pathological bucket without changing a decision. */
export const MAX_CANDIDATES_PER_ROW = 1024;

const NASAB_PARTICLES = new Set([
  "\u0628\u0646",
  "\u0627\u0628\u0646",
  "\u0627\u0628\u0648",
  "\u0627\u0628\u064a",
]);

/** Token-sorted folding key minus nasab particles; a name made only of particles falls back to itself. */
export function narratorBlockingKey(foldedName: string): string {
  const tokens = foldedName
    .split(" ")
    .filter((token) => token.length > 0 && !NASAB_PARTICLES.has(token))
    .sort();
  return tokens.length > 0 ? tokens.join(" ") : foldedName;
}

export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The min-hash of a trigram set under 96 universal permutations. Two hashes per
 * trigram define the permutation family; the index never compares an estimate, so
 * collisions only add candidates.
 */
export function minhashSignature(trigrams: readonly string[]): number[] {
  const signature = new Array<number>(SIGNATURE_LENGTH).fill(0xffffffff);
  for (const trigram of trigrams) {
    const first = fnv1a(trigram);
    const second = fnv1a(`${trigram}\u0000salt`);
    for (let index = 0; index < SIGNATURE_LENGTH; index += 1) {
      const candidate = (first + Math.imul(index, second)) >>> 0;
      if (candidate < signature[index]!) signature[index] = candidate;
    }
  }
  return signature;
}

/** One bucket key per band; two signatures share at least one band on a candidate. */
export function lshBandKeys(signature: readonly number[]): string[] {
  const keys: string[] = [];
  for (let band = 0; band < LSH_BANDS; band += 1) {
    const start = band * LSH_ROWS;
    let key = `${band}`;
    for (let row = 0; row < LSH_ROWS; row += 1) key += `:${signature[start + row] ?? 0}`;
    keys.push(key);
  }
  return keys;
}

export type LshIndex<T> = Map<string, T[]>;

export function addToLshIndex<T>(index: LshIndex<T>, bandKeys: readonly string[], value: T): void {
  for (const key of bandKeys) {
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [value]);
    else bucket.push(value);
  }
}

export type LshSearchResult<T> = { values: T[]; truncated: boolean };

/** Union of every bucket the query keys hit, deduplicated and capped. */
export function searchLshIndex<T>(
  index: LshIndex<T>,
  bandKeys: readonly string[],
): LshSearchResult<T> {
  const seen = new Set<T>();
  const values: T[] = [];
  let truncated = false;
  for (const key of bandKeys) {
    const bucket = index.get(key);
    if (bucket === undefined) continue;
    for (const value of bucket) {
      if (seen.has(value)) continue;
      seen.add(value);
      if (values.length < MAX_CANDIDATES_PER_ROW) values.push(value);
      else truncated = true;
    }
  }
  return { values, truncated };
}
