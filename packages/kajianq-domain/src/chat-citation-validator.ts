import type { Chunk } from "@app/rag-core";

/**
 * Deterministic citation validator (spec §3.3 step 7): every citation in the
 * answer must exist in the retrieved chunks' citation labels. Pure string
 * work — no LLM, no engine-domain leakage; the label formats are data on the
 * chunks.
 */

/** Citation labels carried by each retrieved chunk's metadata. */
export function citationLabelsOf(chunk: Chunk): string[] {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  const citation = meta["citation"];
  if (typeof citation === "string" && citation.trim() !== "") return [citation.trim()];
  if (Array.isArray(citation)) {
    return citation.filter((c): c is string => typeof c === "string" && c.trim() !== "");
  }
  return [];
}

/**
 * Check the draft's answer: which of the retrieved chunks' citation labels
 * appear in the text, and which citation labels in the text are ungrounded
 * (appear in the answer but exist in no retrieved chunk).
 *
 * A citation label is "present" when its exact string occurs in the answer.
 */
export function validateCitations(
  answer: string,
  chunks: readonly Chunk[],
): { grounded: string[]; ungrounded: string[] } {
  const known = new Set<string>();
  for (const chunk of chunks) {
    for (const label of citationLabelsOf(chunk)) known.add(label);
  }
  const grounded: string[] = [];
  const ungrounded: string[] = [];
  for (const label of known) {
    if (answer.includes(label)) grounded.push(label);
  }
  // Ungrounded detection: citation-shaped labels (a short "source: ref" form)
  // in the answer that exist in no retrieved chunk. Kept deliberately
  // format-agnostic: a label is anything quoted between citation brackets.
  for (const match of answer.matchAll(/\[([^[\]]+)\]/g)) {
    const label = (match[1] ?? "").trim();
    if (label === "" || known.has(label)) continue;
    if (!ungrounded.includes(label)) ungrounded.push(label);
  }
  return { grounded, ungrounded };
}
