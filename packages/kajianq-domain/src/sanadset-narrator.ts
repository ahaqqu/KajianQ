/**
 * The narrator catalogue the study measures: one cluster per folded name, the
 * blocking groups those clusters fall into, and the resolution arithmetic the
 * report quotes.
 *
 * The deterministic pass resolves a mention only when the fold merges it with
 * another mention. A singleton is not "resolved" by having an id of its own — it is
 * the residue the model would have to place, and counting it as resolved is the
 * silent inflation this module exists to prevent.
 */

import { narratorBlockingKey } from "./sanadset-blocking";

export type NarratorMention = { readonly raw: string; readonly folded: string };

export type NarratorCluster = {
  /** Mentions of this folded name across every chain. */
  readonly mentions: number;
  /** Distinct raw spellings folded into this name, most frequent first. */
  readonly surfaces: readonly string[];
};

export type NarratorStats = {
  readonly mentions: number;
  readonly rawDistinct: number;
  readonly foldedDistinct: number;
  /** Raw spellings the fold merged into an existing name (rawDistinct - foldedDistinct). */
  readonly foldedVariants: number;
  readonly singletonClusters: number;
  readonly singletonMentions: number;
  readonly resolvedMentions: number;
  readonly resolutionRate: number;
  readonly blockingKeys: number;
  readonly multiNameBlockingKeys: number;
  /** Distinct folded names sharing a blocking key with another name: the band's candidates. */
  readonly bandNames: number;
  /** Sum of `choose(k, 2)` over blocking groups: candidate "same narrator?" pairs. */
  readonly candidatePairs: number;
  readonly largestBlockingGroup: number;
};

export type NarratorCatalogue = {
  readonly clusters: Map<string, NarratorCluster>;
  /** Blocking key -> distinct folded names, sorted; only keys with two or more names are kept. */
  readonly blockingGroups: Map<string, readonly string[]>;
  readonly stats: NarratorStats;
};

function countSurfaces(surfaces: Map<string, number>, raw: string): void {
  surfaces.set(raw, (surfaces.get(raw) ?? 0) + 1);
}

/** Build the catalogue in one pass over every mention; the blocking pass follows. */
export function buildNarratorCatalogue(mentions: Iterable<NarratorMention>): NarratorCatalogue {
  const surfacesByFolded = new Map<string, Map<string, number>>();
  const counts = new Map<string, number>();
  const rawNames = new Set<string>();
  let totalMentions = 0;

  for (const mention of mentions) {
    totalMentions += 1;
    if (mention.raw.length > 0) rawNames.add(mention.raw);
    counts.set(mention.folded, (counts.get(mention.folded) ?? 0) + 1);
    const surfaces = surfacesByFolded.get(mention.folded);
    if (surfaces === undefined) surfacesByFolded.set(mention.folded, new Map([[mention.raw, 1]]));
    else countSurfaces(surfaces, mention.raw);
  }

  const clusters = new Map<string, NarratorCluster>();
  const byBlockingKey = new Map<string, Set<string>>();
  let singletonClusters = 0;
  let singletonMentions = 0;

  for (const [folded, mentionCount] of counts) {
    const surfaceCounts = surfacesByFolded.get(folded) ?? new Map<string, number>();
    const ranked = [...surfaceCounts.entries()]
      .sort(
        (left, right) =>
          right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0),
      )
      .map(([surface]) => surface);
    clusters.set(folded, { mentions: mentionCount, surfaces: ranked });
    if (mentionCount === 1) {
      singletonClusters += 1;
      singletonMentions += 1;
    }
    const key = narratorBlockingKey(folded);
    const group = byBlockingKey.get(key);
    if (group === undefined) byBlockingKey.set(key, new Set([folded]));
    else group.add(folded);
  }

  const blockingGroups = new Map<string, readonly string[]>();
  let multiNameBlockingKeys = 0;
  let bandNames = 0;
  let candidatePairs = 0;
  let largestBlockingGroup = 0;
  for (const [key, names] of byBlockingKey) {
    if (names.size < 2) continue;
    multiNameBlockingKeys += 1;
    bandNames += names.size;
    candidatePairs += (names.size * (names.size - 1)) / 2;
    largestBlockingGroup = Math.max(largestBlockingGroup, names.size);
    blockingGroups.set(key, [...names].sort());
  }

  const resolvedMentions = totalMentions - singletonMentions;
  return {
    clusters,
    blockingGroups,
    stats: {
      mentions: totalMentions,
      rawDistinct: rawNames.size,
      foldedDistinct: clusters.size,
      foldedVariants: rawNames.size - clusters.size,
      singletonClusters,
      singletonMentions,
      resolvedMentions,
      resolutionRate: totalMentions === 0 ? 0 : resolvedMentions / totalMentions,
      blockingKeys: byBlockingKey.size,
      multiNameBlockingKeys,
      bandNames,
      candidatePairs,
      largestBlockingGroup,
    },
  };
}

/** The most frequent raw surface for a folded name; null when the name is unknown. */
export function representativeSurface(catalogue: NarratorCatalogue, folded: string): string | null {
  return catalogue.clusters.get(folded)?.surfaces[0] ?? null;
}

/** Folded names seen exactly once, sorted — the singleton stratum's population. */
export function singletonNames(catalogue: NarratorCatalogue): string[] {
  const names: string[] = [];
  for (const [folded, cluster] of catalogue.clusters)
    if (cluster.mentions === 1) names.push(folded);
  return names.sort();
}
