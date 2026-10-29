import type { NarratorChainRecord, NarratorRecord } from "@app/infra";
import { GRADES, type Grade } from "./filters";

/**
 * The domain pack's view of the graph rows the store seam calls narrators and
 * narrator chains, bound to CONTEXT.md's vocabulary.
 *
 * The engine's physical and record names are role-based, and its records carry the
 * pack's own columns as pass-through it never interprets: the pack owns the
 * concepts and narrows the rows. This is where `NarratorChainRecord` becomes the
 * **Isnad** — the ordered chain of narrators through which a hadith was
 * transmitted — and where a grade is narrowed to the four-value Grade vocabulary
 * instead of an opaque string. The boundary gate's remaining terms are
 * review-enforced (ADR-0019), so this ownership is what keeps the two
 * vocabularies honest.
 *
 * The two readers below are the seam's typed boundary, and they refuse rather
 * than coerce: a stored grade outside the vocabulary, or a reliability map whose
 * entries are not assessments, means the row was not written by this product (or
 * the store is broken), and returning a null or a guessed value would let a
 * citation present evidence the store never held.
 */

/**
 * One critic's assessment of a narrator, as jarh wa ta'dil records it: the
 * critic's own verdict term, plus where that critic said it.
 *
 * `verdict` is a string, not an enum: the discipline's vocabulary is far richer
 * than a closed list (thiqa, saduq, la-ba'sa-bihi, dhaif, matruk, …) and a
 * closed enum would force a false equivalence between terms a specialist
 * distinguishes. It is never empty.
 */
export type CriticAssessment = {
  /** The critic's own wording of the assessment; opaque to code, rendered as recorded. */
  readonly verdict: string;
  /** Where the critic recorded it (work, volume, page) — the citation anchor. */
  readonly sourceRef?: string;
  /** A short qualifier or context the verdict needs to be read correctly. */
  readonly note?: string;
};

/** Critic key → that critic's assessment of one narrator. Keys are domain-chosen. */
export type NarratorReliability = Readonly<Record<string, CriticAssessment>>;

/** A narrator row with its reliability map validated into the domain shape. */
export type Narrator = Omit<NarratorRecord, "reliabilityByCritic"> & {
  readonly reliabilityByCritic: NarratorReliability;
};

/**
 * The per-chain row (CONTEXT.md "Isnad"), with its grade narrowed to the domain
 * vocabulary and paired with the grader the schema requires. The union is the
 * type-level half of the database's `narrator_chains_grade_attribution` CHECK:
 * an ungraded chain has no grader either, and a graded chain carries a non-blank
 * grader, so no consumer can render an unattributed grade.
 */
export type Isnad = Omit<NarratorChainRecord, "grade" | "grader"> &
  (
    | { readonly grade: null; readonly grader: null }
    | { readonly grade: Grade; readonly grader: string }
  );

/** A stored graph row the domain cannot read under its own contract. */
export class NarratorShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NarratorShapeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a stored reliability map into {@link NarratorReliability}, refusing any
 * shape that would not render as "critic — verdict (source)": a non-object, an
 * empty critic key, a non-object entry, or an entry without a non-empty
 * `verdict`. Unknown extra keys on an entry are tolerated and ignored, so a
 * later producer can extend the payload without a reader change silently
 * mistaking the row for malformed; the assessed fields stay exactly these.
 */
export function parseNarratorReliability(value: unknown): NarratorReliability {
  if (!isRecord(value)) {
    throw new NarratorShapeError("narrator reliability must be an object keyed by critic");
  }
  const reliability: Record<string, CriticAssessment> = {};
  for (const [critic, raw] of Object.entries(value)) {
    if (critic.trim() === "") {
      throw new NarratorShapeError("narrator reliability carries an empty critic key");
    }
    if (!isRecord(raw)) {
      throw new NarratorShapeError(`narrator reliability entry '${critic}' is not an assessment`);
    }
    const verdict = raw["verdict"];
    if (typeof verdict !== "string" || verdict.trim() === "") {
      throw new NarratorShapeError(`narrator reliability entry '${critic}' has no verdict`);
    }
    const sourceRef = raw["sourceRef"];
    if (sourceRef !== undefined && typeof sourceRef !== "string") {
      throw new NarratorShapeError(`narrator reliability entry '${critic}' has a non-text source`);
    }
    const note = raw["note"];
    if (note !== undefined && typeof note !== "string") {
      throw new NarratorShapeError(`narrator reliability entry '${critic}' has a non-text note`);
    }
    reliability[critic] = {
      verdict,
      ...(sourceRef !== undefined ? { sourceRef } : {}),
      ...(note !== undefined ? { note } : {}),
    };
  }
  return reliability;
}

/** Read one narrator row into the domain shape, validating its reliability map. */
export function asNarrator(record: NarratorRecord): Narrator {
  return { ...record, reliabilityByCritic: parseNarratorReliability(record.reliabilityByCritic) };
}

/**
 * The schema's `narrator_chains_grade_attribution` rule as a function: a grade and
 * a non-blank grader are present or absent together. Exported so the memory double
 * seeds only rows the database would accept — a DB-less test must not be handed a
 * shape the real store would refuse.
 */
export function assertGradeAttribution(grade: string | null, grader: string | null): void {
  if ((grade === null) !== (grader === null)) {
    throw new NarratorShapeError(
      grade === null
        ? "isnad carries a grader without a grade"
        : `isnad grade '${grade}' carries no grader`,
    );
  }
  if (grader !== null && grader.trim() === "") {
    throw new NarratorShapeError("isnad grader is blank");
  }
}

/**
 * Read one chain row into the domain shape. A grade outside CONTEXT.md's four is
 * refused: the schema's CHECK constraint admits only the four, so seeing another
 * value means the row did not come through this product's write path — and a null
 * would silently drop the classification a citation is about to render. The
 * grade/grader pairing is refused on the same footing, mirroring the schema, so an
 * unattributed grade cannot narrow into a citation-ready Isnad.
 */
export function asIsnad(record: NarratorChainRecord): Isnad {
  const { grade, grader } = record;
  if (grade !== null && !(GRADES as readonly string[]).includes(grade)) {
    throw new NarratorShapeError(`isnad grade '${grade}' is outside the Grade vocabulary`);
  }
  assertGradeAttribution(grade, grader);
  if (grade === null) {
    return { ...record, grade: null, grader: null };
  }
  return { ...record, grade: grade as Grade, grader: grader as string };
}
