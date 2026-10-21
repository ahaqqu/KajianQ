import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { Chunk, StoreError } from "@app/rag-core";
import {
  RETRIEVED_SCOPE_KEY,
  expandRetrievedSurahScope,
  shortSurahsAmong,
} from "./chat-surah-completion";
import {
  SCOPE_EXPANSION_ORIGIN,
  type ScopeBridge,
  type ScopeChildRow,
  type ScopeStore,
} from "./chat-scope-expansion";
import { surahSourceKey } from "./quran-source";

/**
 * Short-surah completion (ADR-0045's second trigger) — the read, its bounds and
 * the trace detail. A retrieved verse whose surah fits the budget pulls that
 * surah's children from the opening; a long surah, a disabled cap or a set with
 * no verse issues no read.
 */

function verse(surah: number, ayah: number): Chunk {
  return {
    id: `c-${surah}:${ayah}`,
    text: `ar-${surah}:${ayah}`,
    metadata: { sourceType: "quran", surah, ayah, citation: `QS. ${surah}:${ayah}` },
  };
}

function rows(surah: number, count: number): ScopeChildRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${surah}-${i + 1}`,
    textAr: `ar-${surah}:${i + 1}`,
    textId: `id-${surah}:${i + 1}`,
    metadata: {
      sourceType: "quran",
      surah,
      ayah: i + 1,
      citation: `QS. ${surah}:${i + 1}`,
    },
  }));
}

/** A store whose parent-scoped read answers from a fixed map and records every read. */
function storeOf(corpus: Record<number, ScopeChildRow[]>): {
  store: ScopeStore;
  reads: { parent: string; limit: number; fromOrdinal?: number }[];
} {
  const reads: { parent: string; limit: number; fromOrdinal?: number }[] = [];
  const store: ScopeStore = {
    listDocChildrenByParentSourceKey(parentSourceKey, opts) {
      reads.push({
        parent: parentSourceKey,
        limit: opts.limit,
        ...(opts.fromOrdinal === undefined ? {} : { fromOrdinal: opts.fromOrdinal }),
      });
      const surah = Number(parentSourceKey.split("/").at(-1));
      return Effect.succeed((corpus[surah] ?? []).slice(0, opts.limit));
    },
  };
  return { store, reads };
}

const bridge: ScopeBridge = <A>(effect: Effect.Effect<A, StoreError>) => Effect.runPromise(effect);

describe("shortSurahsAmong", () => {
  it("names each short surah once, in retrieval order", () => {
    const retrieved = [verse(1, 3), verse(2, 255), verse(1, 5), verse(112, 2)];
    expect(shortSurahsAmong(retrieved, 12)).toEqual([1, 112]);
  });

  it("skips a surah whose verse count exceeds the budget", () => {
    expect(shortSurahsAmong([verse(2, 255)], 12)).toEqual([]);
  });

  it("skips chunks that are not Quran verses", () => {
    const hadith: Chunk = {
      id: "h",
      text: "matn",
      metadata: { sourceType: "hadith", surah: 1 },
    };
    expect(shortSurahsAmong([hadith], 12)).toEqual([]);
  });

  it("issues no target when the budget is zero", () => {
    expect(shortSurahsAmong([verse(1, 3)], 0)).toEqual([]);
  });
});

describe("expandRetrievedSurahScope", () => {
  it("reads the surah from its opening and adds what the caller does not hold", async () => {
    const { store, reads } = storeOf({ 1: rows(1, 7) });
    const result = await Effect.runPromise(
      expandRetrievedSurahScope({
        retrieved: [verse(1, 3)],
        existingIds: new Set(["1-3"]),
        cap: 12,
        store,
        bridge,
      }),
    );
    expect(reads).toEqual([{ parent: surahSourceKey(1), limit: 13 }]);
    expect(result.chunks).toHaveLength(6);
    expect(result.chunks.map((c) => c.metadata?.["citation"])).toEqual([
      "QS. 1:1",
      "QS. 1:2",
      "QS. 1:4",
      "QS. 1:5",
      "QS. 1:6",
      "QS. 1:7",
    ]);
    for (const chunk of result.chunks) expect(chunk.origin).toBe(SCOPE_EXPANSION_ORIGIN);
    expect(result.scopes).toEqual([
      { key: RETRIEVED_SCOPE_KEY, value: "1", returned: 6, cap: 12, truncated: false },
    ]);
  });

  it("issues no read when no retrieved verse's surah fits the budget", async () => {
    const { store, reads } = storeOf({ 2: rows(2, 286) });
    const result = await Effect.runPromise(
      expandRetrievedSurahScope({
        retrieved: [verse(2, 255)],
        existingIds: new Set(),
        cap: 12,
        store,
        bridge,
      }),
    );
    expect(reads).toEqual([]);
    expect(result).toEqual({ chunks: [], scopes: [] });
  });

  it("spends the budget across the targets in retrieval order and flags the cut", async () => {
    const { store, reads } = storeOf({ 112: rows(112, 4), 108: rows(108, 3) });
    const result = await Effect.runPromise(
      expandRetrievedSurahScope({
        retrieved: [verse(112, 2), verse(108, 1)],
        existingIds: new Set(),
        cap: 5,
        store,
        bridge,
      }),
    );
    // Each target fits the budget on its own; the first spends most of it, so the
    // second's read is cut to what remains.
    expect(reads).toEqual([
      { parent: surahSourceKey(112), limit: 6 },
      { parent: surahSourceKey(108), limit: 2 },
    ]);
    expect(result.chunks).toHaveLength(5);
    expect(result.scopes).toEqual([
      { key: RETRIEVED_SCOPE_KEY, value: "112", returned: 4, cap: 5, truncated: false },
      { key: RETRIEVED_SCOPE_KEY, value: "108", returned: 1, cap: 1, truncated: true },
    ]);
  });

  it("adds nothing and records the read when the surah's children are all in context", async () => {
    const { store } = storeOf({ 112: rows(112, 4) });
    const result = await Effect.runPromise(
      expandRetrievedSurahScope({
        retrieved: [verse(112, 2)],
        existingIds: new Set(["112-1", "112-2", "112-3", "112-4"]),
        cap: 12,
        store,
        bridge,
      }),
    );
    expect(result.chunks).toEqual([]);
    expect(result.scopes).toEqual([
      { key: RETRIEVED_SCOPE_KEY, value: "112", returned: 0, cap: 12, truncated: false },
    ]);
  });

  it("fails closed when the store read fails", async () => {
    const store: ScopeStore = {
      listDocChildrenByParentSourceKey: () => Effect.fail({ kind: "transport" } as never),
    };
    await expect(
      Effect.runPromise(
        expandRetrievedSurahScope({
          retrieved: [verse(1, 3)],
          existingIds: new Set(),
          cap: 12,
          store,
          bridge,
        }),
      ),
    ).rejects.toBeTruthy();
  });
});
