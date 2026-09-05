import { Effect } from "effect";
import type { Provider } from "@app/rag-core";

/**
 * A deterministic, dependency-free cross-lingual embedder for tests.
 *
 * Purpose: make the ID→AR retrieval *mechanics* machine-checkable without
 * spending API budget. Real cross-lingual quality is the #9 benchmark
 * gate's job; this fake models the property ADR-0013 depends on — the same
 * concept expressed in Indonesian and in Arabic lands at nearby vectors,
 * while unrelated texts land far apart — so the pipeline's search, ranking,
 * and citation plumbing are exercised for real.
 *
 * Mapping: each concept gets a base vector from a seeded hash of the
 * canonical term; a query in either language is looked up through the
 * provided dictionary and placed at the concept's vector plus a small
 * deterministic jitter, so same-language beats cross-language only by a
 * hair (mirrors real cross-lingual recall).
 */
export type CrossLingualDictionary = {
  /** Canonical concept key shared by both language tracks. */
  [concept: string]: {
    /** Arabic surface forms (primary track) that express the concept. */
    ar: readonly string[];
    /** Indonesian surface forms (query side). */
    id: readonly string[];
  };
};

function hashToUnit(seed: string, dim: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const vec = Array.from({ length: dim }, (_, i) => {
    let v = Math.imul(h + i * 0x9e3779b9, 0x85ebca6b);
    v ^= v >>> 13;
    return ((v >>> 0) % 10_000) / 10_000 - 0.5;
  });
  return normalize(vec);
}

function normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

/** Jitter a vector deterministically by a small amount. */
function jitter(vec: readonly number[], amount: number): number[] {
  return normalize(vec.map((x, i) => x + ((i % 3) - 1) * amount));
}

function longestContains(text: string, terms: readonly string[]): string | null {
  const hay = text.toLowerCase();
  let best: string | null = null;
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (hay.includes(needle) && (best === null || needle.length > best.length)) best = term;
  }
  return best;
}

/** Find the dictionary concept a text expresses, or null. */
function conceptFor(text: string, dict: CrossLingualDictionary): string | null {
  for (const [concept, sides] of Object.entries(dict)) {
    if (longestContains(text, sides.ar) !== null) return concept;
    if (longestContains(text, sides.id) !== null) return concept;
  }
  return null;
}

export function createCrossLingualEmbedder(
  dict: CrossLingualDictionary,
  dim = 16,
): Provider & { vectorsFor: (texts: readonly string[]) => number[][] } {
  const cache = new Map<string, number[]>();
  const embed = (text: string): number[] => {
    const cached = cache.get(text);
    if (cached) return cached;
    const concept = conceptFor(text, dict);
    const vec =
      concept === null
        ? hashToUnit(`noise:${text}`, dim)
        : jitter(hashToUnit(concept, dim), 0.02);
    cache.set(text, vec);
    return vec;
  };
  return {
    modelId: "test-cross-lingual",
    embed: (spec) =>
      Effect.sync(() => ({
        vectors: spec.texts.map(embed),
        cost: {
          modelId: "test-cross-lingual",
          tokensIn: spec.texts.length,
          tokensOut: 0,
          latencyMs: 0,
          costMicroUsd: 0,
        },
      })),
    generate: () => Effect.die("cross-lingual test embedder does not generate"),
    stream: () => Effect.die("cross-lingual test embedder does not stream"),
    vectorsFor: (texts) => texts.map(embed),
  };
}