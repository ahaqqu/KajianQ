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
 * Four properties are load-bearing:
 *
 * - **The fit is the condition.** A surah whose verse count exceeds the
 *   configured cap is not a target, so a completion can never pour a long surah
 *   into the prompt; only a surah one bounded read can hold is ever completed.
 * - **The read starts at the opening**, because the verse a question needs may
 *   precede the one retrieval returned, and a read beginning at the retrieved
 *   verse cannot reach it.
 * - **The budget is the caller's, and it is shared** with the named-reference
 *   read: the caller passes the configured cap and what that read left of it,
 *   and nothing left issues no read.
 * - **Held children spend nothing and every target is recorded.** The target's
 *   verse count is known, so the children the caller already holds are filtered
 *   before the budget is sliced, and `truncated` reports only unheld children
 *   pushed out. A cut read and a read the budget never reached each leave their
 *   own record, because a completion that vanished would hide what the shared
 *   budget cost.
 */

/**
 * The opaque scope key a completion's trace event carries. It is distinct from
 * the named-reference scope's key, so a trace reader can tell a surah the
 * question named from one retrieval returned.
 */
export const RETRIEVED_SCOPE_KEY = "retrieved_surah";

/** One surah to complete, with the verse count the fit test read. */
type CompletionTarget = { surah: number; ayahCount: number };

/**
 * The surahs to complete, in retrieval order, once each: every retrieved Quran
 * chunk's surah whose verse count fits `cap`. Pure, so the replay of a recorded
 * retrieval can name the same targets a live read would. The count travels with
 * the target, so the read below bounds itself by the surah's own children
 * rather than by a second lookup of the same table.
 */
function completionTargets(retrieved: readonly Chunk[], cap: number): readonly CompletionTarget[] {
  if (cap <= 0) return [];
  const seen = new Set<number>();
  const targets: CompletionTarget[] = [];
  for (const chunk of retrieved) {
    const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
    if (meta["sourceType"] !== "quran") continue;
    const surah = meta["surah"];
    if (typeof surah !== "number" || !Number.isInteger(surah)) continue;
    if (seen.has(surah)) continue;
    const ayahCount = SURAH_AYAH_COUNTS[surah - 1];
    if (ayahCount === undefined || ayahCount > cap) continue;
    seen.add(surah);
    targets.push({ surah, ayahCount });
  }
  return targets;
}

/** The surah numbers `completionTargets` names, in the same order. */
export function shortSurahsAmong(retrieved: readonly Chunk[], cap: number): readonly number[] {
  return completionTargets(retrieved, cap).map((target) => target.surah);
}

/**
 * Read each target surah's children from its opening and add the ones the
 * caller does not already hold, bounded by the budget this read was given.
 *
 * The read asks for the surah's known verse count, and the caller's held ids are
 * filtered out before the budget slice: a row already in context is read but
 * spends nothing, so `truncated` is true only when unheld children fell outside
 * the budget. Returns one scope detail per target — a cut read, a read whose
 * children were all in context, and a target the shared budget never reached
 * (`returned: 0` with the `skipped` reason), so a read that added nothing is
 * machinery the trace still shows — and issues no store read when no retrieved
 * verse's surah fits the configured cap.
 */
export function expandRetrievedSurahScope(input: {
  retrieved: readonly Chunk[];
  existingIds: ReadonlySet<string>;
  cap: number;
  remaining: number;
  store: ScopeStore;
  bridge: ScopeBridge;
}): Effect.Effect<
  { chunks: readonly Chunk[]; scopes: readonly ScopeDetail[] },
  { cause: unknown }
> {
  return Effect.gen(function* () {
    const targets = completionTargets(input.retrieved, input.cap);
    if (targets.length === 0) return { chunks: [], scopes: [] };
    const chunks: Chunk[] = [];
    const scopes: ScopeDetail[] = [];
    for (const target of targets) {
      const remaining = input.remaining - chunks.length;
      if (remaining <= 0) {
        scopes.push({
          key: RETRIEVED_SCOPE_KEY,
          value: String(target.surah),
          returned: 0,
          cap: input.cap,
          remaining: 0,
          truncated: true,
          skipped: "budget",
        });
        continue;
      }
      const rows = yield* Effect.tryPromise({
        try: () =>
          input.bridge(
            input.store.listDocChildrenByParentSourceKey(surahSourceKey(target.surah), {
              limit: target.ayahCount,
            }),
          ),
        catch: (cause: unknown) => ({ cause }),
      });
      const unheld = rows.filter((row) => !input.existingIds.has(row.id));
      const added = unheld
        .slice(0, remaining)
        .map((row) => expansionChunk(row, SCOPE_EXPANSION_ORIGIN));
      chunks.push(...added);
      scopes.push({
        key: RETRIEVED_SCOPE_KEY,
        value: String(target.surah),
        returned: added.length,
        cap: input.cap,
        remaining,
        truncated: unheld.length > remaining,
      });
    }
    return { chunks, scopes };
  });
}
