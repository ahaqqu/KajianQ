import { Effect } from "effect";
import type { Chunk } from "@app/rag-core";
import { SURAH_AYAH_COUNTS } from "./surah-names";
import { surahSourceKey } from "./quran-source";
import {
  SCOPE_EXPANSION_ORIGIN,
  expansionChunk,
  type ScopeBridge,
  type ScopeDetail,
  type ScopeStore,
} from "./chat-scope-expansion";

/**
 * Short-surah completion (ADR-0045's second trigger) — the retrieval half.
 *
 * The fused tracks can return one verse of a short surah and leave the rest of
 * that surah out: the passage around the returned verse competes with it for
 * the per-search cut, and the one-ordinal neighbourhood read (ADR-0049) both
 * stops one ordinal from the anchor and spends its cap on the best-ranked
 * windows. So a surah that **fits the read's budget** is read whole from its
 * opening when retrieval returned any of its verses — the same deterministic,
 * bounded read the named-reference trigger uses, on a trigger that is what
 * retrieval returned rather than what the question named.
 *
 * Three properties are load-bearing:
 *
 * - **The fit is the condition.** A surah whose verse count exceeds the budget
 *   is not a target, so a completion can never pour a long surah into the
 *   prompt; only a surah one bounded read can hold is ever completed.
 * - **The read starts at the opening**, because the verse a question needs may
 *   precede the one retrieval returned, and a read beginning at the retrieved
 *   verse cannot reach it.
 * - **The budget is the caller's, and it is shared** with the named-reference
 *   read: the caller passes what remains, and `0` issues no read.
 */

/**
 * The opaque scope key a completion's trace event carries. It is distinct from
 * the named-reference scope's key, so a trace reader can tell a surah the
 * question named from one retrieval returned.
 */
export const RETRIEVED_SCOPE_KEY = "retrieved_surah";

/**
 * The surahs to complete, in retrieval order, once each: every retrieved Quran
 * chunk's surah whose verse count fits `cap`. Pure, so the replay of a recorded
 * retrieval can name the same targets a live read would.
 */
export function shortSurahsAmong(retrieved: readonly Chunk[], cap: number): readonly number[] {
  if (cap <= 0) return [];
  const seen = new Set<number>();
  const surahs: number[] = [];
  for (const chunk of retrieved) {
    const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
    if (meta["sourceType"] !== "quran") continue;
    const surah = meta["surah"];
    if (typeof surah !== "number" || !Number.isInteger(surah)) continue;
    if (seen.has(surah)) continue;
    const ayahCount = SURAH_AYAH_COUNTS[surah - 1];
    if (ayahCount === undefined || ayahCount > cap) continue;
    seen.add(surah);
    surahs.push(surah);
  }
  return surahs;
}

/**
 * Read each target surah's children from its opening and add the ones the
 * caller does not already hold, bounded by `cap`. Returns one scope detail per
 * surah read — including one whose children were all in context, so a read that
 * added nothing is machinery the trace still shows — and issues no store read
 * when no retrieved verse's surah fits the budget.
 *
 * The reads share `cap` with the named-reference read through the caller, which
 * passes what that read left; a surah whose read is worth more than the
 * remaining budget is added up to it and flags `truncated`.
 */
export function expandRetrievedSurahScope(input: {
  retrieved: readonly Chunk[];
  existingIds: ReadonlySet<string>;
  cap: number;
  store: ScopeStore;
  bridge: ScopeBridge;
}): Effect.Effect<
  { chunks: readonly Chunk[]; scopes: readonly ScopeDetail[] },
  { cause: unknown }
> {
  return Effect.gen(function* () {
    const targets = shortSurahsAmong(input.retrieved, input.cap);
    if (targets.length === 0) return { chunks: [], scopes: [] };
    const chunks: Chunk[] = [];
    const scopes: ScopeDetail[] = [];
    for (const surah of targets) {
      const remaining = input.cap - chunks.length;
      if (remaining <= 0) break;
      // Read one past the remaining budget: a full `remaining + 1` result is the
      // exact signal that the surah offers more children than this read may add.
      const rows = yield* Effect.tryPromise({
        try: () =>
          input.bridge(
            input.store.listDocChildrenByParentSourceKey(surahSourceKey(surah), {
              limit: remaining + 1,
            }),
          ),
        catch: (cause: unknown) => ({ cause }),
      });
      const truncated = rows.length > remaining;
      const added: Chunk[] = [];
      for (const row of rows.slice(0, remaining)) {
        if (input.existingIds.has(row.id)) continue;
        added.push(expansionChunk(row, SCOPE_EXPANSION_ORIGIN));
      }
      chunks.push(...added);
      scopes.push({
        key: RETRIEVED_SCOPE_KEY,
        value: String(surah),
        returned: added.length,
        cap: remaining,
        truncated,
      });
    }
    return { chunks, scopes };
  });
}
