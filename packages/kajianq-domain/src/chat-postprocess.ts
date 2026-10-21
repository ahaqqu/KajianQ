import type { AssembledContext, Chunk, Draft } from "@app/rag-core";
import type { KajianQFilters } from "./filters";
import { MACHINE_TRANSLATION_LABEL } from "./chat-assembler";

/**
 * Deterministic product rules applied after the reviewer passes a draft
 * (spec §2.2 "Grade flag — Always — deterministic"). These are the rules the
 * answer *cannot* be trusted to satisfy on its own, because the model may
 * simply forget them:
 *
 * - **Dhaif warning** — a retrieved hadith graded weak is always flagged
 *   visibly, whether or not the model remembered to mention it.
 * - **Machine-translation label** — when the answer quotes a translated
 *   passage, the label travels with it (ADR-0006).
 * - **Ulama disclaimer** — every delivered answer closes with the
 *   not-a-fatwa disclaimer.
 *
 * The dhaif warning and the machine-translation label are appended: the model's
 * own text is preserved, and a rule whose own copy the text already carries is
 * not duplicated (a second copy is a visible defect). For the **dhaif rule**,
 * "already carries" means the product's copy, never a model paraphrase of it —
 * that control is deterministic precisely so it does not depend on the model.
 *
 * The **disclaimer** has one owner: the rule. Its canonical copy is the last
 * paragraph of every delivered answer, and every disclaimer-like sentence in
 * the draft — a paraphrase included — is removed before the copy is written, so
 * the reader sees the wording the contract promises exactly once, at the close,
 * instead of a paraphrase beside it. A suppression predicate cannot give that
 * guarantee: a paraphrase it matches leaves the canonical line out, and one it
 * does not leaves two disclaimers.
 *
 * Which rules changed the delivered text is returned in
 * `ProductRulesResult.applied` and recorded on the trace by the only production
 * caller (`chat-reviewer.ts`'s `withRules`) as a `product_rules` event, on every
 * path that applies the rules. The event's PRESENCE is what says the rules ran;
 * absence says they did not only for traces written after the kind shipped
 * (ADR-0007), since a trace written before it carries no such event although the
 * rules ran. An empty `applied` says the rules ran and left the draft's text as
 * it was; it does not separate "no rule had a trigger" from "a trigger matched
 * and the rule was already satisfied". The delivered text stays the single
 * source of truth for what the answer says.
 */

export type ProductRulesResult = {
  draft: Draft;
  /**
   * Which deterministic rules changed the delivered text, in application order.
   * Recorded verbatim on the reviewer stage's `product_rules` trace event. `[]`
   * says the rules ran and left the draft's text as it was; it does not separate
   * "no rule had a trigger" from "a trigger matched and the rule was already
   * satisfied", and it is not the same as the rules being skipped (that records
   * no event at all).
   */
  applied: readonly string[];
};

/** The dhaif warning line (ID/EN). */
export function dhaifWarning(language: "id" | "en"): string {
  return language === "en"
    ? "[Warning] The cited hadith is graded weak (dhaif); it may not be used as a primary proof."
    : "[Peringatan] Hadits yang dikutip berderajat lemah (dhaif); tidak dapat dijadikan dalil utama.";
}

/**
 * The not-a-fatwa disclaimer (ID/EN) — the copy every delivered answer closes
 * with, and the one wording the product promises. `applyProductRules` owns it.
 */
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

/**
 * The claim every disclaimer makes, in either language — the answer is not a
 * fatwa. It is the CLAIM, not the product's copy, because the rule has to
 * recognise the model's own wording of it: that wording is what it removes
 * before writing the copy the contract promises. A sentence that only advises
 * consulting a scholar, without denying that the answer is a fatwa, is a
 * different promise and is not matched.
 */
const DISCLAIMER_CLAIM =
  /\b(?:bukan(?:lah)?\s+(?:merupakan\s+)?(?:sebuah\s+)?fatwa|not\s+(?:a|an)\s+fatwa)\b/iu;

/**
 * The units a disclaimer can occupy. A sentence ends at a run of terminal
 * punctuation in either script, plus any markdown that immediately closes it:
 * a bold sentence ends `.**`, and a delimiter left outside the boundary would
 * merge the next sentence into the unit and take it with the removal. The
 * refusal split reads a sentence the same way. A paragraph break is a unit
 * boundary too. The split KEEPS the separators, so everything the rule does not
 * remove survives byte-for-byte — an abbreviation like "QS." only makes a unit
 * shorter, never merges text across a boundary.
 */
const DISCLAIMER_UNITS = /([.!?؟۔]+[*_~`]*)(?=\s|$)/;

/** Runs of the wrap-only markdown a sentence may carry; never answer bytes. */
const WRAP_RUNS = /\*+|_+|~+|`+/g;

/**
 * Drop every unit that carries the disclaimer claim, keeping the other bytes.
 * When the removed unit opened a markdown wrap that the paragraph closes later,
 * the closing run survives as the paragraph's only run of its marker — an
 * orphaned delimiter, not answer text — and is removed with it.
 */
function dropDisclaimerUnits(paragraph: string): string {
  const units = paragraph.split(DISCLAIMER_UNITS);
  const opening = /^\s*([*_~`]+)/.exec(paragraph)?.[1] ?? "";
  const openingDropped = DISCLAIMER_CLAIM.test(units[0] ?? "");
  let kept = "";
  for (let i = 0; i < units.length; i += 2) {
    if (DISCLAIMER_CLAIM.test(units[i] ?? "")) continue;
    kept += (units[i] ?? "") + (units[i + 1] ?? "");
  }
  if (openingDropped && opening !== "") {
    const runs = kept.match(WRAP_RUNS) ?? [];
    const [run] = runs;
    if (runs.length === 1 && run !== undefined && kept.trimEnd().endsWith(run)) {
      kept = kept.trimEnd().slice(0, -run.length);
    }
  }
  return kept;
}

/**
 * Remove the draft's own disclaimer, whatever its wording and wherever the
 * model put it, so the canonical copy the rule appends is the answer's only
 * disclaimer and it sits at the close the renderer peels. A paragraph the
 * removal empties is dropped; a paragraph whose other sentences survive keeps
 * them (a disclaimer folded in beside a dhaif note loses only its own sentence).
 */
function withoutDisclaimer(text: string): string {
  if (!DISCLAIMER_CLAIM.test(text)) return text;
  const kept = text
    .split(/\n{2,}/)
    .map((paragraph) => dropDisclaimerUnits(paragraph).trim())
    .filter((paragraph) => paragraph !== "");
  return kept.join("\n\n");
}

/**
 * True when the text already carries the product's own dhaif warning copy, in
 * either language. Exported because this IS what the citations frame's
 * `dhaifWarning` flag means (`apps/api/src/lib/chat-citations.ts`): one
 * predicate, two readers, so the delivered answer and the frame derived from
 * it can never disagree about whether the warning is present.
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
  return text.includes(dhaifWarning("id")) || text.includes(dhaifWarning("en"));
}

/**
 * Apply the deterministic product rules to a draft. It is called for every
 * text the run delivers as answer content — the reviewer-passed draft, the
 * pre-gate skip, the no-provider exit, and a HYBRID refusal (a grounded partial
 * answer that runs into the canonical sentence).
 *
 * Three shapes do NOT reach here, and none is decorated. A PURE refusal — the
 * sentence citing nothing and adding nothing of its own beyond its framing
 * (`isRefusalOnly`) — is already the honest answer, and decorating it would
 * bury the reason the user got one; a warning on it would also be invented, its
 * trigger being the assembled context rather than the text. An ASSERTING
 * refusal draft — the sentence riding a text that cites nothing and is not a
 * decline — takes the reviewer stage's backstop instead: the product's own
 * refusal text ships in place of the draft's words, so there is no text of the
 * model's to decorate and no rule to invent a trigger for. The deterministic
 * gate's own `ungrounded_citation` refusal (the refusal decision's first row)
 * replaces the draft for the same reason.
 */
export function applyProductRules(
  draft: Draft,
  context: AssembledContext<KajianQFilters>,
  language: "id" | "en",
): ProductRulesResult {
  const applied: string[] = [];
  // The disclaimer's wording is the rule's. Removing the draft's own before
  // anything is appended is what makes the canonical copy the answer's only
  // disclaimer, at the close, whichever way the model phrased or placed it.
  const body = withoutDisclaimer(draft.text);
  const parts: string[] = body === "" ? [] : [body];

  if (hasWeakGradeChunk(context.chunks) && !hasWeakWarning(body)) {
    parts.push(dhaifWarning(language));
    applied.push("dhaif_warning");
  }
  if (contextHasTranslation(context) && !quotesTranslation(body)) {
    // The label is a provenance claim about the text that follows it; if the
    // model dropped it, restore it as a standalone notice rather than
    // guessing which line it belonged to. The label is intentionally
    // language-invariant (ADR-0006): one Indonesian constant, no EN variant.
    parts.push(`[${MACHINE_TRANSLATION_LABEL}]`);
    applied.push("machine_translation_label");
  }
  const text = [...parts, ulamaDisclaimer(language)].join("\n\n");
  // The copy is always written, but the rule is recorded only when doing so
  // changed the delivered text: a draft that already closed with it is left
  // as the model wrote it, and the event stays a record of change, not of
  // execution (the event's presence already says the rules ran).
  if (text !== draft.text.trim()) {
    applied.push("ulama_disclaimer");
  }

  return { draft: { text }, applied };
}
