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
 * a rule whose own copy the text already carries is not duplicated (a double
 * disclaimer is a visible defect). For the **dhaif rule**, "already carries"
 * means the product's copy, never a model paraphrase of it — that control is
 * deterministic precisely so it does not depend on the model (ticket #278).
 * The disclaimer predicate is deliberately looser: `hasDisclaimer` accepts any
 * "bukan fatwa" phrasing, and whether a paraphrase satisfies the disclaimer or
 * the canonical copy is required (the dhaif rule's treatment) is an open
 * product-copy decision owned by ticket #284.
 *
 * Which rules fired is returned in `ProductRulesResult.applied`, not recorded
 * on the trace: the only production caller (`chat-reviewer.ts`'s `withRules`)
 * discards it, so a fired rule is observable today through the text it
 * appended to the delivered answer. Putting it on the trace is a trace-contract
 * addition (a new `TraceEventSchema` kind), tracked by ticket #285.
 */

export type ProductRulesResult = {
  draft: Draft;
  /**
   * Which deterministic rules appended text, in application order. Returned to
   * the caller; the production caller currently discards it, so this is not on
   * the trace (ticket #285).
   */
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

/**
 * True when the text already carries the product's own dhaif warning copy, in
 * either language. Exported because this IS what the citations frame's
 * `dhaifWarning` flag means (`apps/api/src/lib/chat-citations.ts`): one
 * predicate, two readers, so the delivered answer and the frame derived from
 * it can never disagree about whether the warning is present.
 *
 * The predicate is deliberately the COPY, not the grade vocabulary (ticket
 * #278). The deterministic evidence renders a weak-grade chunk's label as
 * `(Dhaif)` — `renderEvidenceChunk` appends the store's grade — and the
 * generator is instructed to reproduce the evidence's labels verbatim, so an
 * answer whose context carries a dhaif chunk contains the bare token `dhaif`
 * for a reason that is not a warning at all. Suppressing on the token
 * therefore switched the control OFF on exactly the answers it exists for.
 * Measured on the staging store (2026-09-28, read-only): of 95 non-refused
 * answers whose assembled context carried a dhaif-graded chunk, 81 carried no
 * canonical warning line and all 81 matched the token — zero cases lacked the
 * line without a token match. Spec §2.2 makes the grade flag an "Always"
 * control so it does not depend on the model, so only the copy suppresses; an
 * informal weakness claim gains the canonical line exactly as an informal
 * "lemah" already did (round-3 B4).
 */
export function hasWeakWarning(text: string): boolean {
  return text.includes(dhaifWarning("id")) || text.includes(dhaifWarning("en"));
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
    // guessing which line it belonged to. The label is intentionally
    // language-invariant (ADR-0006): one Indonesian constant, no EN variant.
    parts.push(`[${MACHINE_TRANSLATION_LABEL}]`);
    applied.push("machine_translation_label");
  }
  if (!hasDisclaimer(draft.text)) {
    parts.push(ulamaDisclaimer(language));
    applied.push("ulama_disclaimer");
  }

  return { draft: { text: parts.join("\n\n") }, applied };
}
