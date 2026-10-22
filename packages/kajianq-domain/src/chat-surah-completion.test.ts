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
        remaining: 12,
        store,
        bridge,
      }),
    );
    expect(reads).toEqual([{ parent: surahSourceKey(1), limit: 7 }]);
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
      {
        key: RETRIEVED_SCOPE_KEY,
        value: "1",
        returned: 6,
        cap: 12,
        remaining: 12,
        truncated: false,
      },
    ]);
  });

  it("issues no read when no retrieved verse's surah fits the budget", async () => {
    const { store, reads } = storeOf({ 2: rows(2, 286) });
    const result = await Effect.runPromise(
      expandRetrievedSurahScope({
        retrieved: [verse(2, 255)],
        existingIds: new Set(),
        cap: 12,
        remaining: 12,
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
        remaining: 5,
        store,
        bridge,
      }),
    );
    // Each target fits the budget on its own; the first spends most of it, so the
    // second's read is cut to what remains.
    expect(reads).toEqual([
      { parent: surahSourceKey(112), limit: 4 },
      { parent: surahSourceKey(108), limit: 3 },
    ]);
    expect(result.chunks).toHaveLength(5);
    expect(result.scopes).toEqual([
      {
        key: RETRIEVED_SCOPE_KEY,
        value: "112",
        returned: 4,
        cap: 5,
        remaining: 5,
        truncated: false,
      },
      {
        key: RETRIEVED_SCOPE_KEY,
        value: "108",
        returned: 1,
        cap: 5,
        remaining: 1,
        truncated: true,
      },
    ]);
  });

  it("filters the children a caller already holds before the budget slice", async () => {
    // A three-verse surah followed by an eight-verse one, three of whose
    // children are already in context, under a budget of eight. Held rows spend
    // no budget, so the second read must reach the surah's last verse.
    const { store, reads } = storeOf({ 108: rows(108, 3), 98: rows(98, 8) });
    const result = await Effect.runPromise(
      expandRetrievedSurahScope({
        retrieved: [verse(108, 2), verse(98, 1)],
        existingIds: new Set(["108-2", "108-3", "98-1", "98-2", "98-3"]),
        cap: 8,
        remaining: 8,
        store,
        bridge,
      }),
    );
    expect({
      added: result.chunks.map((chunk) => chunk.metadata?.["citation"]),
      scopes: result.scopes,
    }).toEqual({
      added: ["QS. 108:1", "QS. 98:4", "QS. 98:5", "QS. 98:6", "QS. 98:7", "QS. 98:8"],
      scopes: [
        {
          key: RETRIEVED_SCOPE_KEY,
          value: "108",
          returned: 1,
          cap: 8,
          remaining: 8,
          truncated: false,
        },
        {
          key: RETRIEVED_SCOPE_KEY,
          value: "98",
          returned: 5,
          cap: 8,
          remaining: 7,
          truncated: false,
        },
      ],
    });
    // Each read asks for the surah's known verse count, never one past it.
    expect(reads).toEqual([
      { parent: surahSourceKey(108), limit: 3 },
      { parent: surahSourceKey(98), limit: 8 },
    ]);
  });

  it("records a target the shared budget cut and one it starved", async () => {
    // Three short surahs compete for one budget of seven: the first leaves one
    // unit, the second is cut to its opening, the third is never read. Every
    // target still leaves its own record — the trace is where the shared
    // budget's cost is legible.
    const { store, reads } = storeOf({ 1: rows(1, 7), 112: rows(112, 4), 108: rows(108, 3) });
    const result = await Effect.runPromise(
      expandRetrievedSurahScope({
        retrieved: [verse(1, 3), verse(112, 2), verse(108, 1)],
        existingIds: new Set(["1-3"]),
        cap: 7,
        remaining: 7,
        store,
        bridge,
      }),
    );
    expect(result.scopes).toEqual([
      {
        key: RETRIEVED_SCOPE_KEY,
        value: "1",
        returned: 6,
        cap: 7,
        remaining: 7,
        truncated: false,
      },
      {
        key: RETRIEVED_SCOPE_KEY,
        value: "112",
        returned: 1,
        cap: 7,
        remaining: 1,
        truncated: true,
      },
      {
        key: RETRIEVED_SCOPE_KEY,
        value: "108",
        returned: 0,
        cap: 7,
        remaining: 0,
        truncated: true,
        skipped: "budget",
      },
    ]);
    // Only the targets with budget left issued a store read.
    expect(reads.map((read) => read.parent)).toEqual([surahSourceKey(1), surahSourceKey(112)]);
  });

  it("adds nothing and records the read when the surah's children are all in context", async () => {
    const { store } = storeOf({ 112: rows(112, 4) });
    const result = await Effect.runPromise(
      expandRetrievedSurahScope({
        retrieved: [verse(112, 2)],
        existingIds: new Set(["112-1", "112-2", "112-3", "112-4"]),
        cap: 12,
        remaining: 12,
        store,
        bridge,
      }),
    );
    expect(result.chunks).toEqual([]);
    expect(result.scopes).toEqual([
      {
        key: RETRIEVED_SCOPE_KEY,
        value: "112",
        returned: 0,
        cap: 12,
        remaining: 12,
        truncated: false,
      },
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
          remaining: 12,
          store,
          bridge,
        }),
      ),
    ).rejects.toBeTruthy();
  });
});
