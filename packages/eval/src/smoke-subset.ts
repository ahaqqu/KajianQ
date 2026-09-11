import type { GoldenQuestion, GoldenSet } from "@app/contracts";

/**
 * Smoke-subset selection (ticket #10 AC: "Golden Set smoke subset passes
 * against staging"). The full Golden Set costs real money and minutes; a PR
 * needs a small, *representative* slice that can run on the free tier.
 *
 * Selection is deterministic and stratified, not "the first N": a subset that
 * happened to contain only easy factual questions would pass while the
 * refusal and trap behaviour silently regressed — the failure this gate
 * exists to prevent. The selector therefore guarantees coverage of the
 * behaviours the product's risk table names (refusal, weak-grade trap,
 * language) before filling the remaining budget by stable order.
 *
 * "Deterministic" means: same set + same budget ⇒ same subset, on any machine.
 * No randomness, no clock, no hash of an unstable serialization.
 */

export type SmokeSelection = {
  set: GoldenSet;
  /** Why each question was picked (for the CLI's printed plan). */
  reasons: readonly { id: string; reason: string }[];
};

export type SmokeSelectOptions = {
  /** Maximum questions in the subset (default 5 — the spec's PR-time size). */
  size?: number;
  /** Tag marking a trap question (product vocabulary, caller-supplied). */
  trapTag?: string;
};

/**
 * Pick a representative smoke subset. Order of preference:
 *   1. one refusal case (the plain-refusal behaviour)
 *   2. one trap-tagged case (fabricated citation / weak grade)
 *   3. one English case (language matching)
 *   4. one Indonesian answer case (the default path)
 *   5. remaining slots: the set's own order, skipping duplicates of the above
 */
export function selectSmokeSubset(set: GoldenSet, opts: SmokeSelectOptions = {}): SmokeSelection {
  const size = Math.max(1, opts.size ?? 5);
  const trapTag = opts.trapTag ?? "dhaif-trap";
  const picked: GoldenQuestion[] = [];
  const reasons: { id: string; reason: string }[] = [];
  const taken = new Set<string>();

  const take = (q: GoldenQuestion | undefined, reason: string): void => {
    if (!q || taken.has(q.id) || picked.length >= size) return;
    taken.add(q.id);
    picked.push(q);
    reasons.push({ id: q.id, reason });
  };

  const has = (q: GoldenQuestion, tag: string): boolean => (q.tags ?? []).includes(tag);

  take(
    set.questions.find((q) => q.expectedBehavior === "refuse"),
    "refusal coverage",
  );
  take(
    set.questions.find((q) => (q.tags ?? []).some((t) => t === trapTag)),
    "trap coverage",
  );
  take(
    set.questions.find((q) => q.language === "en"),
    "English language coverage",
  );
  take(
    set.questions.find((q) => q.language === "id" && q.expectedBehavior === "answer"),
    "Indonesian answer coverage",
  );
  for (const q of set.questions) {
    if (picked.length >= size) break;
    take(q, "fill (stable order)");
  }

  return {
    set: { ...set, id: `${set.id}-smoke`, questions: picked },
    reasons,
  };
}
