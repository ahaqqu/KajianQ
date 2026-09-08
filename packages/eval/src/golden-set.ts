import * as v from "valibot";
import { GoldenSetSchema, type GoldenQuestion, type GoldenSet } from "@app/contracts";

/**
 * GoldenSetLoader (#8): read/validate a versioned question-set fixture.
 * Validation is total — a malformed question fails the load, never a silent
 * skip, because a Golden Set that silently drops questions lies about
 * coverage. The fixture's question/citation vocabularies are opaque strings
 * here; the domain pack owns their formats.
 */

/** A loader failure with the fixture path and the valibot issues attached. */
export class GoldenSetLoadError extends Error {
  constructor(
    readonly source: string,
    readonly issues: readonly string[],
  ) {
    super(`golden set "${source}" failed validation: ${issues.join("; ")}`);
  }
}

/** Validate an already-parsed fixture object against the contract. */
export function parseGoldenSet(raw: unknown, source = "inline"): GoldenSet {
  const parsed = v.safeParse(GoldenSetSchema, raw);
  if (!parsed.success) {
    throw new GoldenSetLoadError(
      source,
      parsed.issues.map((i) => `${i.path?.map((p) => String(p.key)).join(".") ?? "?"}: ${i.message}`),
    );
  }
  return parsed.output;
}

/**
 * Load a fixture from a JSON string (the CLI reads the file; this module
 * stays I/O-free for testability).
 */
export function loadGoldenSetJson(json: string, source = "inline"): GoldenSet {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    throw new GoldenSetLoadError(source, [`invalid JSON: ${String(cause)}`]);
  }
  return parseGoldenSet(raw, source);
}

/**
 * The minimum content bar v0's plan fixes for a draft fixture. The trap tag
 * label is product vocabulary — the caller (the domain fixture loader)
 * supplies it, keeping this engine module vocabulary-free.
 */
export function assertV0Shape(
  set: GoldenSet,
  opts: {
    trapTag: string;
    minIndonesian?: number;
    minRefusals?: number;
    minTraps?: number;
    minQuestions?: number;
  },
): void {
  const minIndonesian = opts.minIndonesian ?? 14;
  const minRefusals = opts.minRefusals ?? 2;
  const minTraps = opts.minTraps ?? 1;
  const minQuestions = opts.minQuestions ?? 20;
  const idQuestions = set.questions.length;
  const indonesian = set.questions.filter((q) => q.language === "id").length;
  const refusals = set.questions.filter((q) => q.expectedBehavior === "refuse").length;
  const traps = set.questions.filter((q) => (q.tags ?? []).includes(opts.trapTag)).length;
  const problems: string[] = [];
  if (indonesian < minIndonesian) {
    problems.push(`only ${indonesian} Indonesian questions (need >= ${minIndonesian})`);
  }
  if (refusals < minRefusals) {
    problems.push(`only ${refusals} refusal cases (need >= ${minRefusals})`);
  }
  if (traps < minTraps) problems.push(`only ${traps} trap-tagged questions (need >= ${minTraps})`);
  if (idQuestions < minQuestions) {
    problems.push(`only ${idQuestions} questions (v0 targets ${minQuestions})`);
  }
  if (problems.length > 0) {
    throw new GoldenSetLoadError(set.id, problems);
  }
}

export type { GoldenQuestion };