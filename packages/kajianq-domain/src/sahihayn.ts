import type { MetadataFilterMatch } from "@app/infra";
import { GRADES, type Grade } from "./filters";
import type { HadithCollection } from "./hadith-source";

/**
 * **The sahihayn's read-time grade** — the one derivation behind both places a
 * row's grade decides retrieval (CONTEXT.md "Sahihayn").
 *
 * **Basis.** Bukhari and Muslim are the collections the term *sahihayn* names:
 * what they carry is canonically sahih, so a row from either with no stored
 * grade is not "ungraded because unknown" — its collection is the evidence.
 * The source provides no per-grader grades for them, and ADR-0026 forbids
 * fabricating one, so the grade is resolved here and never written.
 *
 * **Scope.** Exactly two consumers: the hierarchy bonus and the `grade` filter.
 * Citation labels render what the corpus stores, the dhaif warning reads the
 * stored grade, and no other path sees this value — an ungraded row from any
 * other collection stays ungraded.
 */
export const SAHIHAYN_BASIS = {
  /** The grade an ungraded sahihayn row is read as. */
  grade: "sahih" satisfies Grade,
  /** The metadata key the grade is stored under — its absence is the condition. */
  gradeKey: "grade",
  /** The metadata key naming the row's collection — the evidence for the reading. */
  collectionKey: "collection",
  collections: ["bukhari", "muslim"] as const satisfies readonly HadithCollection[],
} as const;

/**
 * The grade a row is **read** with: its stored grade when it carries one, and
 * {@link SAHIHAYN_BASIS.grade} for an ungraded row whose collection is one of
 * the sahihayn.
 *
 * A stored grade always wins, so a sahihayn row the source graded `dhaif` stays
 * dhaif. Only an absent grade (`null` or missing — the same condition the store
 * reads as `metadata->>grade IS NULL`) derives, and a value that is present but
 * is not a grade this pack knows is left alone rather than reinterpreted.
 * `undefined` means the row is ungraded with no basis to read it otherwise.
 */
export function effectiveGrade(metadata: Record<string, unknown>): Grade | undefined {
  const stored = metadata[SAHIHAYN_BASIS.gradeKey];
  if (typeof stored === "string" && (GRADES as readonly string[]).includes(stored)) {
    return stored as Grade;
  }
  if (stored !== null && stored !== undefined) return undefined;
  const collection = metadata[SAHIHAYN_BASIS.collectionKey];
  return typeof collection === "string" &&
    (SAHIHAYN_BASIS.collections as readonly string[]).includes(collection)
    ? SAHIHAYN_BASIS.grade
    : undefined;
}

/**
 * The `sahih` value's expansion, as data for the store: the rows
 * {@link effectiveGrade} resolves to `sahih` without a stored grade, expressed
 * as the store's derived case — no value for the grade key, and a collection
 * among {@link SAHIHAYN_BASIS.collections}. Data only: the engine binds the keys
 * and values as parameters and never learns what either means.
 *
 * `undefined` when `sahih` is not among the values, so every other grade keeps
 * exact-equality semantics and a filter never widens to evidence it did not ask
 * about.
 */
export function sahihFilterExpansion(values: readonly string[]): MetadataFilterMatch | undefined {
  if (!values.includes(SAHIHAYN_BASIS.grade)) return undefined;
  return {
    values: [...values],
    whenAbsent: {
      key: SAHIHAYN_BASIS.collectionKey,
      values: [...SAHIHAYN_BASIS.collections],
    },
  };
}
