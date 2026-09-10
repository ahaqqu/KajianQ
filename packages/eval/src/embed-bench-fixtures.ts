import * as v from "valibot";
import type { ExpansionCase } from "./embed-bench";

/**
 * Embedding-benchmark fixtures (#9): the versioned probe/query and
 * expansion-case files the domain pack supplies. Shapes validated here; the
 * contents (Arabic terms, Indonesian queries) are product vocabulary — this
 * engine module stays domain-agnostic.
 */

/** One benchmark probe: a query plus its relevant corpus ids (by sourceKey). */
const BenchQuerySchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  text: v.pipe(v.string(), v.minLength(1)),
  relevantIds: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
});

/** The probe fixture: one file holds every direction's probes. */
export const BenchProbeSetSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  /** Corpus fingerprint the probes were authored against (re-verify on load). */
  corpusFingerprint: v.pipe(v.string(), v.minLength(1)),
  /** Cross-lingual probes: query = secondary text, relevant = primary doc(s). */
  crossLingual: v.pipe(v.array(BenchQuerySchema), v.minLength(1)),
  /** Monolingual baseline probes: query = primary text of a held-out doc. */
  monolingual: v.pipe(v.array(BenchQuerySchema), v.minLength(1)),
});

export type BenchProbeSet = v.InferOutput<typeof BenchProbeSetSchema>;

/** The expansion micro-task fixture (ADR-0014 consumption de-risk). */
export const ExpansionCaseSetSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  cases: v.pipe(
    v.array(
      v.object({
        id: v.pipe(v.string(), v.minLength(1)),
        query: v.pipe(v.string(), v.minLength(1)),
        slice: v.unknown(),
        expectedTerm: v.pipe(v.string(), v.minLength(1)),
        distractors: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
      }),
    ),
    v.minLength(1),
  ),
});

export type ExpansionCaseSet = v.InferOutput<typeof ExpansionCaseSetSchema>;

/** Parse + validate a probe fixture from parsed JSON. */
export function parseProbeSet(raw: unknown, source = "inline"): BenchProbeSet {
  const parsed = v.safeParse(BenchProbeSetSchema, raw);
  if (!parsed.success) {
    throw new Error(
      `${source} failed validation: ${parsed.issues
        .map((i) => `${i.path?.map((p) => String(p.key)).join(".") ?? "?"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.output;
}

/** Parse + validate an expansion fixture from parsed JSON. */
export function parseExpansionSet(raw: unknown, source = "inline"): ExpansionCaseSet {
  const parsed = v.safeParse(ExpansionCaseSetSchema, raw);
  if (!parsed.success) {
    throw new Error(
      `${source} failed validation: ${parsed.issues
        .map((i) => `${i.path?.map((p) => String(p.key)).join(".") ?? "?"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.output;
}
