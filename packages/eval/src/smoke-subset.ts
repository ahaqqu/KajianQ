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
  /**
   * Classes the full set carries but the sample does not exercise, because
   * every eligible question is held out. Named so the printed plan can say
   * what the deployed gate no longer covers instead of passing silently.
   */
  unavailable: readonly { reason: string; heldOut: readonly string[] }[];
  /**
   * Expected source types the full set asks for but the sample no longer
   * requires: the retrieval paths the gate no longer exercises. Values are the
   * fixture's own opaque vocabulary.
   */
  uncoveredSourceTypes: readonly string[];
  /** The caller's held-out ids, in the set's order (for the printed plan). */
  heldOutIds: readonly string[];
};

/**
 * A required tag the fixture does not carry: the caller and the set disagree
 * about the vocabulary. Thrown, never skipped — see `selectSmokeSubset`.
 */
export class SmokeSubsetError extends Error {
  override readonly name = "SmokeSubsetError";
}

/** The keys `SmokeSelectOptions` declares — the guard and its message share them. */
const KNOWN_SMOKE_OPTIONS = ["size", "requiredTags", "exclude"] as const;

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
  /**
   * Question ids the caller holds out of the sample, supplied opaquely (the
   * engine names no product id). A held-out question is not eligible for a
   * class rule or the fill; a class with no eligible question is reported as
   * unavailable rather than filled from a held-out case. The held-out case
   * stays in the caller's full set, which this function never mutates. An id
   * the set does not carry is a caller/fixture disagreement and throws, like a
   * missing `requiredTags` entry.
   */
  exclude?: readonly string[];
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
 * the budget must fit every class the available set carries:
 *   1. one refusal case (the plain-refusal behaviour)
 *   2. one question per required tag, in the caller's order (the label
 *      classes the product's risk table names)
 *   3. one English case (language matching)
 *   4. one Indonesian answer case (the default path)
 *   5. remaining slots: the set's own order, skipping duplicates of the above
 *
 * A class the available set carries but the budget cannot fit throws — a
 * subset that silently dropped it would be a weaker gate than the plan it
 * prints. A class the available set does not carry because every eligible
 * question is held out is reported in `unavailable`, never filled from a
 * held-out question; a class the fixture does not carry at all is the
 * fixture's content bar to enforce, and only a required tag is fatal there. A
 * hold-out list that would leave the sample empty throws.
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

  // One eligibility boundary: every class rule, the fill and the coverage check
  // read the same available set, so a held-out id cannot re-enter by another path.
  const available = set.questions.filter((q) => !exclude.has(q.id));

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

  const unavailable: { reason: string; heldOut: readonly string[] }[] = [];
  for (const cls of coverage) {
    const carriers = set.questions.filter(cls.present);
    if (carriers.length === 0) {
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
    const match = available.find(cls.present);
    if (match === undefined) {
      // The class is carried by the fixture but every carrier is held out: report
      // it, never fill it from a held-out question. A required tag in this state
      // is a caller contradiction, not a coverage gap.
      if (cls.tag !== undefined) {
        throw new SmokeSubsetError(
          `required tag "${cls.tag}" is carried only by held-out question(s) ` +
            `(${carriers.map((q) => q.id).join(", ")})`,
        );
      }
      unavailable.push({ reason: cls.reason, heldOut: carriers.map((q) => q.id) });
      continue;
    }
    take(match, cls.reason);
  }

  // A class the available set carries but the budget did not fit is a silently
  // weaker gate: assert over the picked questions, not over the plan's intentions.
  const missed = coverage.filter((cls) => available.some(cls.present) && !picked.some(cls.present));
  if (missed.length > 0) {
    throw new SmokeSubsetError(
      `size ${size} cannot cover every class the available set carries (missing: ${missed
        .map((cls) => cls.reason)
        .join(", ")}; picked ${picked.length}: ${picked.map((q) => q.id).join(", ")})`,
    );
  }

  for (const q of available) {
    if (picked.length >= size) break;
    take(q, "fill (stable order)");
  }

  // A sample with no questions would spend the deploy gate's budget and ask
  // nothing: hold-out lists may narrow the sample, never empty it.
  if (picked.length === 0) {
    throw new SmokeSubsetError(
      `no question left in "${set.id}" after the held-out ids (${set.questions.length} questions)`,
    );
  }

  // Which expected source types the gate no longer asks for: the sample may shrink
  // to cases whose source types never exercise a retrieval path the full set tests.
  const sampleTypes = new Set(picked.flatMap((q) => q.expectedSourceTypes));
  const fixtureTypes = new Set(set.questions.flatMap((q) => q.expectedSourceTypes));

  return {
    set: { ...set, id: `${set.id}-smoke`, questions: picked },
    reasons,
    unavailable,
    uncoveredSourceTypes: [...fixtureTypes].filter((type) => !sampleTypes.has(type)),
    heldOutIds: set.questions.filter((q) => exclude.has(q.id)).map((q) => q.id),
  };
}

/**
 * The run's printed plan: the sample, why each case was picked, every class
 * and expected source type the sample no longer exercises, and the held-out ids
 * the selection used. Kept here rather
 * than in the CLI script so a test can pin the uncovered lines: a gate that
 * passes while silently covering less would be worse than a red one.
 */
export function formatSmokePlan(selection: SmokeSelection, fixture: GoldenSet): readonly string[] {
  return [
    `eval:smoke: ${selection.set.questions.length} of ${fixture.questions.length} questions from "${fixture.id}"`,
    ...selection.reasons.map((r) => `  ${r.id}: ${r.reason}`),
    ...selection.unavailable.map(
      (cls) => `  not covered: ${cls.reason} (held out: ${cls.heldOut.join(", ")})`,
    ),
    ...selection.uncoveredSourceTypes.map((type) => `  not covered: expected source type ${type}`),
    ...(selection.heldOutIds.length > 0
      ? [`  held out of this sample: ${selection.heldOutIds.join(", ")}`]
      : []),
  ];
}
