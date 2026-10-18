import type { GoldenQuestion, GoldenSet } from "@app/contracts";

/**
 * Smoke-subset selection. The full Golden Set costs real money and minutes; a
 * PR needs a small, *representative* slice that can run on the free tier.
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

/**
 * A `trapTag` the fixture does not carry: the caller and the set disagree about
 * the vocabulary. Thrown, never skipped — see `selectSmokeSubset`.
 */
export class SmokeSubsetError extends Error {
  override readonly name = "SmokeSubsetError";
}

export type SmokeSelectOptions = {
  /** Maximum questions in the subset (default 5 — the spec's PR-time size). */
  size?: number;
  /**
   * Tag marking a trap question. Supplied by the caller (the product's
   * vocabulary — the engine must not name it).
   */
  trapTag?: string;
  /**
   * Question ids the caller holds out of the sample, supplied opaquely (the
   * engine names no product id). A held-out question is not eligible for a
   * class rule or the fill, so a class the set still carries is filled from the
   * rest rather than from a held-out case; a class with no eligible question is
   * absent. The held-out case stays in the caller's full set, which this
   * function never mutates. An id the set does not carry is a caller/fixture
   * disagreement and throws, like a missing `trapTag`.
   */
  exclude?: readonly string[];
};

/**
 * Pick a representative smoke subset. Order of preference:
 *   1. one refusal case (the plain-refusal behaviour)
 *   2. one trap-tagged case (fabricated citation / weak grade), when a
 *      `trapTag` is supplied
 *   3. one English case (language matching)
 *   4. one Indonesian answer case (the default path)
 *   5. remaining slots: the set's own order, skipping duplicates of the above
 * Each class is taken from the questions the caller did not hold out; a class
 * with no eligible question is absent rather than filled from a held-out one.
 */
export function selectSmokeSubset(set: GoldenSet, opts: SmokeSelectOptions = {}): SmokeSelection {
  const size = Math.max(1, opts.size ?? 5);
  const trapTag = opts.trapTag;
  const exclude = new Set(opts.exclude ?? []);
  const picked: GoldenQuestion[] = [];
  const reasons: { id: string; reason: string }[] = [];
  const taken = new Set<string>();

  // Fail loudly, never shrink quietly. An excluded id the set does not carry is a
  // caller/fixture disagreement — a renamed question — and ignoring it would leave
  // the gate sampling the case the caller meant to hold out.
  const unknown = [...exclude].filter((id) => !set.questions.some((q) => q.id === id));
  if (unknown.length > 0) {
    throw new SmokeSubsetError(
      `excluded id(s) not in "${set.id}": ${unknown.join(", ")} (${set.questions.length} questions)`,
    );
  }

  const first = (predicate: (q: GoldenQuestion) => boolean): GoldenQuestion | undefined =>
    set.questions.find((q) => !exclude.has(q.id) && predicate(q));

  const isExcluded = (q: GoldenQuestion): boolean => exclude.has(q.id);

  const take = (q: GoldenQuestion | undefined, reason: string): void => {
    if (!q || isExcluded(q) || taken.has(q.id) || picked.length >= size) return;
    taken.add(q.id);
    picked.push(q);
    reasons.push({ id: q.id, reason });
  };

  take(
    first((q) => q.expectedBehavior === "refuse"),
    "refusal coverage",
  );
  if (trapTag !== undefined && trapTag !== "") {
    const trap = first((q) => (q.tags ?? []).includes(trapTag));
    // Fail loudly, never shrink quietly. A `trapTag` no question carries means
    // the caller and the fixture disagree about the vocabulary — a rename that
    // reached one side only. Skipping it would drop the adversarial case from
    // the subset while the run still printed a clean plan, and `eval:smoke` is
    // the gate that runs on every staging deploy: a gate that silently
    // stops testing what it exists to test is worse than a red one.
    if (trap === undefined) {
      throw new SmokeSubsetError(
        `no question in "${set.id}" carries the trap tag "${trapTag}" (${set.questions.length} questions, ` +
          `${set.questions.filter((q) => (q.tags ?? []).length > 0).length} tagged)`,
      );
    }
    take(trap, "trap coverage");
  }
  take(
    first((q) => q.language === "en"),
    "English language coverage",
  );
  take(
    first((q) => q.language === "id" && q.expectedBehavior === "answer"),
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
