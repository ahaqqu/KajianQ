import { gradeLabel, type IsnadEvidence } from "./chat-isnad-evidence";

/**
 * The rendering of chain evidence: the citation sheet's per-chain segments, the
 * one-line sanad form the generator reads, and the narrator-reliability line.
 *
 * It lives apart from the read so both files stay inside the agentic line cap.
 * Ordering is the record's: the segment list is built by mapping the stored rows,
 * never by ranking them, because a reader must see a passage whose chains
 * disagree as disagreement.
 */

/** The label an ungraded row renders instead of a verdict it does not have. */
export const UNGRADED_CHAIN_LABEL = "tanpa penilaian";

/** The separator between narrators inside one rendered sanad. */
export const SANAD_SEPARATOR = " < ";

/**
 * The citation's base address: the chunk's stored label with the flattened grade
 * parenthetical removed. With per-chain evidence present, the flattened value is
 * exactly the claim this ticket forbids — a passage whose chains disagree would
 * read as one grade — so the evidence block renders the chain's own attribution
 * instead. The address itself is untouched, so the citation gate still grounds it.
 */
export function citationBaseAddress(citation: string): string {
  return citation.replace(/\s*\([^()]*\)\s*$/, "").trim();
}

/**
 * One segment per chain, in stored order: `(Grade — grader; sanad: A < B)`, or
 * `(tanpa penilaian; sanad: …)` when no verdict is stored. Every chain is
 * rendered — a reader sees all of them, never the strongest — and an unresolved
 * narrator keeps the id it was stored under rather than vanishing from the chain.
 */
export function renderChainSegments(evidence: IsnadEvidence): string[] {
  const names = new Map(evidence.narrators.map((narrator) => [narrator.id, narrator.nameAr]));
  return evidence.chains.map((chain) => {
    const sequence = chain.narratorIds
      .map((id) => names.get(id) ?? id)
      .join(SANAD_SEPARATOR)
      .trim();
    const attribution =
      chain.grade === null ? UNGRADED_CHAIN_LABEL : `${gradeLabel(chain.grade)} — ${chain.grader}`;
    return `(${attribution}; sanad: ${sequence})`;
  });
}

/**
 * The citation suffix the evidence block and the answer's own citations carry:
 * one parenthetical per stored chain, in stored order. Empty when the child has
 * no row (the address stands alone, exactly as v1 rendered an ungraded hadith).
 */
export function renderChainCitation(evidence: IsnadEvidence): string {
  const segments = renderChainSegments(evidence);
  if (segments.length === 0) return "";
  return `${segments.join(" ")}${evidence.moreMayExist ? ` ${MORE_CHAINS_MARKER}` : ""}`;
}

/** The marker a truncated chain list appends: the prefix is not the whole transmission. */
export const MORE_CHAINS_MARKER = "(+ sanad lain tidak ditampilkan)";

/**
 * The narrator-reliability line for the evidence block, or `""` when no narrator
 * carries a stored verdict. The line is what makes a reliability question
 * answerable from `narrators` rows: the critic, the critic's own verdict term and
 * where it was recorded, per narrator, so the answer can cite it.
 */
export function renderNarratorReliability(evidence: IsnadEvidence): string {
  const lines: string[] = [];
  for (const narrator of evidence.narrators) {
    const assessments = Object.entries(narrator.reliability).map(([critic, assessment]) => {
      const source = assessment.sourceRef === undefined ? "" : ` — ${assessment.sourceRef}`;
      const note = assessment.note === undefined ? "" : ` (${assessment.note})`;
      return `${critic}: ${assessment.verdict}${source}${note}`;
    });
    if (assessments.length === 0) continue;
    lines.push(`${narrator.nameAr ?? narrator.id} — ${assessments.join("; ")}`);
  }
  return lines.length === 0 ? "" : lines.join(" · ");
}
