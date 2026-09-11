import type { AssembledContext, Chunk, Draft } from "@app/rag-core";
import type { KajianQFilters } from "./filters";
import { MACHINE_TRANSLATION_LABEL } from "./chat-assembler";

/**
 * Deterministic product rules applied after the reviewer passes a draft
 * (spec §2.2 "Grade flag — Always — deterministic"; ticket #10 acceptance
 * criteria). These are the rules the answer *cannot* be trusted to satisfy on
 * its own, because the model may simply forget them:
 *
 * - **Dhaif warning** — a retrieved hadith graded weak is always flagged
 *   visibly, whether or not the model remembered to mention it.
 * - **Machine-translation label** — when the answer quotes a translated
 *   passage, the label travels with it (ADR-0006).
 * - **Ulama disclaimer** — every delivered answer closes with the
 *   not-a-fatwa disclaimer.
 *
 * They are appended, never rewritten: the model's own text is preserved, and
 * a rule already satisfied by the text is not duplicated (a double disclaimer
 * is a visible defect). Everything appended is reported so the trace can show
 * which rules fired.
 */

export type ProductRulesResult = {
  draft: Draft;
  /** Which deterministic rules appended text (for the trace). */
  applied: readonly string[];
};

/** The dhaif warning line (ID/EN). */
export function dhaifWarning(language: "id" | "en"): string {
  return language === "en"
    ? "[Warning] The cited hadith is graded weak (dhaif); it may not be used as a primary proof."
    : "[Peringatan] Hadits yang dikutip berderajat lemah (dhaif); tidak dapat dijadikan dalil utama.";
}

/** The not-a-fatwa disclaimer (ID/EN). */
export function ulamaDisclaimer(language: "id" | "en"): string {
  return language === "en"
    ? "This answer is not a fatwa; consult a scholar for legal rulings."
    : "Jawaban ini bukan fatwa; rujuk ulama untuk keputusan hukum.";
}

/** The weak-grade label the ingestion writes into chunk metadata. */
const WEAK_GRADE = "dhaif";

/** True when any retrieved chunk carries the weak grade. */
export function hasWeakGradeChunk(chunks: readonly Chunk[]): boolean {
  return chunks.some((chunk) => {
    const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
    return meta["grade"] === WEAK_GRADE;
  });
}

/** True when the answer quotes a passage the assembler labeled as a translation. */
function quotesTranslation(text: string): boolean {
  // The assembler renders the label directly under the Arabic original; the
  // model is told to keep it, and this check catches when it did not.
  return /Terjemahan mesin|machine translation/i.test(text);
}

/** True when the retrieved context contained a translation the model could quote. */
function contextHasTranslation(context: AssembledContext<KajianQFilters>): boolean {
  return context.turns.some((turn) => turn.content.includes(MACHINE_TRANSLATION_LABEL));
}

/** True when the text already carries a disclaimer (any phrasing we emit). */
function hasDisclaimer(text: string): boolean {
  return /bukan fatwa|not a fatwa/i.test(text);
}

/** True when the text already carries a dhaif warning. */
function hasWeakWarning(text: string): boolean {
  return /dhaif|lemah/i.test(text);
}

/**
 * Apply the deterministic product rules to a passed draft. The refusal path
 * does not reach here: a refusal is already the honest answer, and decorating
 * it with a disclaimer would bury the reason the user got one.
 */
export function applyProductRules(
  draft: Draft,
  context: AssembledContext<KajianQFilters>,
  language: "id" | "en",
): ProductRulesResult {
  const applied: string[] = [];
  const parts: string[] = [draft.text];

  if (hasWeakGradeChunk(context.chunks) && !hasWeakWarning(draft.text)) {
    parts.push(dhaifWarning(language));
    applied.push("dhaif_warning");
  }
  if (contextHasTranslation(context) && !quotesTranslation(draft.text)) {
    // The label is a provenance claim about the text that follows it; if the
    // model dropped it, restore it as a standalone notice rather than
    // guessing which line it belonged to.
    parts.push(
      language === "en" ? `[${MACHINE_TRANSLATION_LABEL}]` : `[${MACHINE_TRANSLATION_LABEL}]`,
    );
    applied.push("machine_translation_label");
  }
  if (!hasDisclaimer(draft.text)) {
    parts.push(ulamaDisclaimer(language));
    applied.push("ulama_disclaimer");
  }

  return { draft: { text: parts.join("\n\n") }, applied };
}
