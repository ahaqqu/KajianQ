import type { GoldenQuestion, GoldenSet } from "@app/contracts";

/**
 * Smoke-subset selection. The full Golden Set costs real money and minutes; a
 * PR needs a small, *representative* slice that can run on the free tier.
 *
 * Selection is deterministic and stratified, not "the first N": a subset that
 * happened to contain only easy factual questions would pass while the
 * refusal, trap and over-refusal behaviour silently regressed — the failure
 * this gate exists to prevent. The selector therefore guarantees coverage of
 * the behaviours the product's risk table names (refusal, the label classes
 * the caller requires, language) before filling the remaining budget by
 * stable order.
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
 * A required tag the fixture does not carry: the caller and the set disagree
 * about the vocabulary. Thrown, never skipped — see `selectSmokeSubset`.
 */
export class SmokeSubsetError extends Error {
  override readonly name = "SmokeSubsetError";
}

/** The keys `SmokeSelectOptions` declares — the guard and its message share them. */
const KNOWN_SMOKE_OPTIONS = ["size", "requiredTags"] as const;

export type SmokeSelectOptions = {
  /** Maximum questions in the subset (default 5 — the deployed smoke's default size). */
  size?: number;
  /**
   * Label tags the product requires the subset to cover, in the caller's
   * order (the product's own Golden Set vocabulary — the engine receives the
   * tags opaquely). One question carrying each tag is taken; a tag no
   * question carries throws rather than shrinking the subset quietly.
   */
  requiredTags?: readonly string[];
};

/** One behaviour the subset must exercise, and how a picked question satisfies it. */
type SmokeCoverage = {
  reason: string;
  present: (question: GoldenQuestion) => boolean;
  /**
   * A required tag: a fixture carrying no such question is a vocabulary
   * disagreement, not a coverage gap the selector may skip.
   */
  tag?: string;
};

/**
 * Pick a representative smoke subset. The classes are taken in this order, and
 * the budget must fit every class the fixture carries:
 *   1. one refusal case (the plain-refusal behaviour)
 *   2. one question per required tag, in the caller's order (the label
 *      classes the product's risk table names)
 *   3. one English case (language matching)
 *   4. one Indonesian answer case (the default path)
 *   5. remaining slots: the set's own order, skipping duplicates of the above
 *
 * A class the set carries but the budget cannot fit throws — a subset that
 * silently dropped it would be a weaker gate than the plan it prints. A class
 * the set does not carry at all is the fixture's content bar to enforce, and
 * only a required tag is fatal there.
 */
export function selectSmokeSubset(set: GoldenSet, opts: SmokeSelectOptions = {}): SmokeSelection {
  const size = Math.max(1, opts.size ?? 5);
  // An option this selector does not know is a caller/contract disagreement,
  // not something to ignore: the smoke runs from a `.mjs` entry typecheck
  // never sees, so a renamed option would otherwise drop a required class
  // while the run printed a clean plan.
  for (const key of Object.keys(opts)) {
    if (!(KNOWN_SMOKE_OPTIONS as readonly string[]).includes(key)) {
      throw new SmokeSubsetError(
        `unknown smoke-subset option "${key}" (known: ${KNOWN_SMOKE_OPTIONS.join(", ")})`,
      );
    }
  }
  const requiredTags = (opts.requiredTags ?? []).filter((tag) => tag !== "");
  const picked: GoldenQuestion[] = [];
  const reasons: { id: string; reason: string }[] = [];
  const taken = new Set<string>();

  const take = (q: GoldenQuestion | undefined, reason: string): void => {
    if (!q || taken.has(q.id) || picked.length >= size) return;
    taken.add(q.id);
    picked.push(q);
    reasons.push({ id: q.id, reason });
  };

  const coverage: readonly SmokeCoverage[] = [
    { reason: "refusal coverage", present: (q) => q.expectedBehavior === "refuse" },
    ...requiredTags.map((tag): SmokeCoverage => ({
      reason: `required tag coverage: ${tag}`,
      present: (q) => (q.tags ?? []).includes(tag),
      tag,
    })),
    { reason: "English language coverage", present: (q) => q.language === "en" },
    {
      reason: "Indonesian answer coverage",
      present: (q) => q.language === "id" && q.expectedBehavior === "answer",
    },
  ];

  for (const cls of coverage) {
    const match = set.questions.find(cls.present);
    if (match === undefined) {
      // Fail loudly, never shrink quietly. A required tag no question carries
      // means the caller and the fixture disagree about the vocabulary — a
      // rename that reached one side only. Skipping it would drop the class
      // from the subset while the run still printed a clean plan, and
      // `eval:smoke` is the gate that runs on every staging deploy: a gate
      // that silently stops testing what it exists to test is worse than red.
      if (cls.tag !== undefined) {
        throw new SmokeSubsetError(
          `no question in "${set.id}" carries the required tag "${cls.tag}" (${set.questions.length} questions, ` +
            `${set.questions.filter((q) => (q.tags ?? []).length > 0).length} tagged)`,
        );
      }
      continue;
    }
    take(match, cls.reason);
  }

  // A class the set carries but the budget did not fit is a silently weaker
  // gate: assert over the picked questions, not over the plan's intentions.
  const missed = coverage.filter(
    (cls) => set.questions.some(cls.present) && !picked.some(cls.present),
  );
  if (missed.length > 0) {
    throw new SmokeSubsetError(
      `size ${size} cannot cover every class the set carries (missing: ${missed
        .map((cls) => cls.reason)
        .join(", ")}; picked ${picked.length}: ${picked.map((q) => q.id).join(", ")})`,
    );
  }

  for (const q of set.questions) {
    if (picked.length >= size) break;
    take(q, "fill (stable order)");
  }

  return {
    set: { ...set, id: `${set.id}-smoke`, questions: picked },
    reasons,
  };
}
