import type { Chunk } from "@app/rag-core";
import {
  citationLabelsOf,
  normalizeCitationLabel,
  validateCitations,
} from "./chat-citation-validator";
import { hasWeakChain, isnadEvidenceOf } from "./chat-isnad-evidence";

/**
 * The weak-evidence rule's copy and trigger, owned together because the one
 * predicate answers both "does the rule fire" (the citations frame's
 * `dhaifWarning` flag) and "which words say why" (the card the answer carries).
 * A passage graded weak and a passage whose transmission carries one weak row
 * are different claims, and the copy must not merge them.
 *
 * **The trigger is the draft's citations, never the retrieved set.** The copy
 * says "the cited hadith"; a weak hadith retrieval merely returned for context
 * is not part of the answer's evidence, so warning about it would tell the
 * reader something false about what the answer leans on. {@link citedWeakGradeScope}
 * is the rule's entry point; {@link weakGradeScope} is the predicate over the
 * passages that entry point selects.
 */

/** The dhaif warning line for a passage graded weak as a whole (ID/EN). */
export function dhaifWarning(language: "id" | "en"): string {
  return language === "en"
    ? "[Warning] The cited hadith is graded weak (dhaif); it may not be used as a primary proof."
    : "[Peringatan] Hadits yang dikutip berderajat lemah (dhaif); tidak dapat dijadikan dalil utama.";
}

/** The dhaif warning line for a passage whose transmission carries the weak row. */
export function dhaifChainWarning(language: "id" | "en"): string {
  return language === "en"
    ? "[Warning] One of the cited hadith's transmission chains is graded weak (dhaif); see the chains below — it may not be used as a primary proof."
    : "[Peringatan] Salah satu sanad hadits yang dikutip berderajat lemah (dhaif); lihat jalur periwayatan di bawah — tidak dapat dijadikan dalil utama.";
}

/** The weak-grade label the ingestion writes into chunk metadata. */
const WEAK_GRADE = "dhaif";

/** What made the weak-evidence rule fire: the passage's grade or one of its rows. */
export type WeakGradeScope = "passage" | "chain";

/**
 * The weak-evidence predicate over the passages it is given, at the precision
 * the warning copy needs: a passage's own flattened grade when one carries it,
 * otherwise a weak row on a passage's transmission evidence, otherwise `null`. A
 * passage grade outranks a weak row because the whole hadith — not one sanad —
 * is then the subject of the warning.
 *
 * Module-private on purpose: the rule's subject is the set the answer cites, and
 * {@link citedWeakGradeScope} is the one caller that builds it. Aimed at the
 * whole retrieved set this predicate would warn about evidence the answer never
 * cites, which is exactly the claim the copy does not make, so it is not
 * exported for a caller to aim wrong.
 */
function weakGradeScope(chunks: readonly Chunk[]): WeakGradeScope | null {
  let chain = false;
  for (const chunk of chunks) {
    const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
    if (meta["grade"] === WEAK_GRADE) return "passage";
    const evidence = isnadEvidenceOf(chunk);
    if (evidence !== null && hasWeakChain(evidence)) chain = true;
  }
  return chain ? "chain" : null;
}

/**
 * The retrieved passages whose own citation label is in the citation gate's
 * grounded set — the only evidence the weak-evidence rule may read.
 *
 * The set is the gate's own: its `grounded` labels are the whole addresses the
 * draft carries that a retrieved chunk grounds, so this cannot disagree with the
 * gate about what the answer cited. A label the draft never wrote is not in it,
 * however prominently retrieval placed the chunk in the context.
 */
function citedChunks(grounded: readonly string[], chunks: readonly Chunk[]): readonly Chunk[] {
  const labels = new Set(grounded);
  return chunks.filter((chunk) =>
    citationLabelsOf(chunk).some((label) => labels.has(normalizeCitationLabel(label))),
  );
}

/**
 * The weak-evidence rule's trigger: the weak scope of the passages the draft
 * cites, or `null` when the answer cites nothing weak.
 *
 * A cited passage graded weak fires, and so does a cited passage whose own grade
 * is sound but whose transmission carries a weak row — the safety property the
 * copy's two scopes exist for. A weak passage that was only retrieved and never
 * cited fires nothing: the delivered answer makes no claim about it, and the
 * warning's copy would be false.
 *
 * `grounded` is the citation gate's grounded labels for this draft when the
 * caller already ran it — the reviewer stage does, for the trace's `grounded`
 * list and the refusal decision — so the rule reads the set the trace recorded
 * instead of validating the same draft a second time. A caller that does not
 * have it omits it; the same `validateCitations` call then derives the same set
 * here, so the two paths cannot define "cited" differently.
 */
export function citedWeakGradeScope(
  draft: string,
  chunks: readonly Chunk[],
  grounded?: readonly string[],
): WeakGradeScope | null {
  const labels = grounded ?? validateCitations(draft, chunks).grounded;
  return weakGradeScope(citedChunks(labels, chunks));
}

/**
 * True when the text already carries the product's own dhaif warning copy, in
 * either language or at either scope. Exported because this IS what the
 * citations frame's `dhaifWarning` flag means: one predicate, two readers, so
 * the delivered answer and the frame derived from it can never disagree about
 * whether the warning is present.
 *
 * The predicate is deliberately the COPY, not the grade vocabulary. The
 * deterministic evidence renders a weak-grade chunk's label as `(Dhaif)` —
 * `renderEvidenceChunk` appends the store's grade — and the generator is
 * instructed to reproduce the evidence's labels verbatim, so an answer whose
 * context carries a dhaif chunk contains the bare token `dhaif` for a reason
 * that is not a warning at all; suppressing on that token would switch the
 * control OFF on exactly the answers it exists for. Spec §2.2 makes the grade
 * flag an "Always" control so it does not depend on the model, so only the copy
 * suppresses; an informal weakness claim gains the canonical line exactly as an
 * informal "lemah" already did.
 */
export function hasWeakWarning(text: string): boolean {
  return (
    text.includes(dhaifWarning("id")) ||
    text.includes(dhaifWarning("en")) ||
    text.includes(dhaifChainWarning("id")) ||
    text.includes(dhaifChainWarning("en"))
  );
}
