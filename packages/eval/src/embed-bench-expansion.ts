/**
 * Expansion micro-task machinery (ADR-0014, #9 gate; thermo B3/C2): the
 * reply parser and the case scorer. Split from `embed-bench.ts` so both
 * stay under the agentic-limits file cap; the domain-agnostic contract —
 * no vendor, no model, no domain vocabulary — is unchanged.
 */

/** One expansion micro-task case (ADR-0014): slice + query → correct term. */
export type ExpansionCase = {
  id: string;
  /** The Indonesian query in natural user wording. */
  query: string;
  /** The verbalized glossary slice offered to the router LLM (opaque JSON). */
  slice: unknown;
  /** The Arabic expansion term a correct selection must include. */
  expectedTerm: string;
  /** Distractor Arabic terms from the same slice the model must not pick. */
  distractors: readonly string[];
};

/** One expansion micro-task outcome. */
export type ExpansionOutcome = {
  caseId: string;
  /** True when the model's selection includes the expected term. */
  correct: boolean;
  /** The raw terms the model picked (post-parse, lowercase-trimmed). */
  picked: readonly string[];
  /** Non-null when the model's reply could not be parsed into terms. */
  parseError?: string;
};

/**
 * Extract lowercase-trimmed terms from the model's JSON answer (thermo B3):
 * the extraction is brace-balanced — a code-fenced reply or a trailing prose
 * object can no longer make the parser grab the wrong span, because the
 * scan walks each `{`-anchored candidate span until JSON.parse succeeds on a
 * balanced object. A non-parseable reply yields `[]` (the runner records it
 * as a parseError via the empty selection, never a silent pass).
 */
export function parseExpansionSelection(text: string): readonly string[] {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    // Walk forward collecting the balanced-brace span from this '{'.
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]!;
      if (inString) {
        if (ch === "\\") {
          i += 1; // skip the escaped character
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const terms = extractTerms(text.slice(start, i + 1));
          if (terms !== null) return terms;
          break; // this span parsed but carried no terms array
        }
      }
    }
    // No balanced close for this '{' — try the next one.
  }
  return [];
}

/** Parse a balanced `{...}` span into the trimmed terms array; null when the object has none. */
function extractTerms(span: string): readonly string[] | null {
  try {
    const parsed: unknown = JSON.parse(span);
    if (typeof parsed !== "object" || parsed === null) return null;
    const terms = (parsed as { terms?: unknown }).terms;
    if (!Array.isArray(terms)) return null;
    return terms
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
  } catch {
    return null;
  }
}

/**
 * Score one expansion case (thermo C2): correct when the model picked the
 * expected term and no distractor from the same slice — a selection that
 * sweeps every candidate including the distractors is not a disambiguation.
 * Distractors are compared trim+lowercase, and a distractor equal to the
 * expected term is ignored (a fixture authoring slip must not void a case).
 * A parseError always fails.
 */
export function scoreExpansionCase(
  outcome: Pick<ExpansionOutcome, "picked" | "parseError">,
  expectedTerm: string,
  distractors: readonly string[] = [],
): boolean {
  if (outcome.parseError !== undefined) return false;
  const norm = (t: string) => t.trim().toLowerCase();
  const expected = norm(expectedTerm);
  if (!outcome.picked.map(norm).includes(expected)) return false;
  const pickedNorm = outcome.picked.map(norm);
  const distractorHit = distractors.map(norm).some((d) => d !== expected && pickedNorm.includes(d));
  return !distractorHit;
}
