import type { AssembledContext, Draft } from "@app/rag-core";
import type { KajianQFilters } from "./filters";
import { MACHINE_TRANSLATION_LABEL } from "./chat-assembler";
import {
  dhaifChainWarning,
  dhaifWarning,
  hasWeakWarning,
  weakGradeScope,
} from "./chat-weak-warning";

export {
  dhaifChainWarning,
  dhaifWarning,
  hasWeakGradeChunk,
  hasWeakWarning,
  type WeakGradeScope,
} from "./chat-weak-warning";

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
 * - **Ulama disclaimer** — an answer the rules decorate closes with the
 *   not-a-fatwa disclaimer.
 *
 * The dhaif warning and the machine-translation label are appended: the model's
 * own text is preserved, and a rule whose own copy the text already carries is
 * not duplicated (a second copy is a visible defect). For the **dhaif rule**,
 * "already carries" means the product's copy, never a model paraphrase of it —
 * that control is deterministic precisely so it does not depend on the model.
 *
 * The **disclaimer** has one owner: the rule. Its canonical copy is the last
 * paragraph of every answer the rules decorate, written whether the draft
 * carried, paraphrased, or omitted the claim. The draft's own disclaimer is
 * cleared unit by unit, and only where the unit's comparison tokens are exactly one
 * of the templates below: a unit carrying any other token is preserved
 * byte-for-byte, so a second disclaimer is possible and a deleted sentence is not.
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

/**
 * The not-a-fatwa disclaimer (ID/EN) — the copy every answer the rules decorate
 * closes with, and the one wording the product promises. `applyProductRules`
 * owns it.
 */
export function ulamaDisclaimer(language: "id" | "en"): string {
  return language === "en"
    ? "This answer is not a fatwa; consult a scholar for legal rulings."
    : "Jawaban ini bukan fatwa; rujuk ulama untuk keputusan hukum.";
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
 * Wrap-only markup — emphasis, strikethrough, code, and the quotation marks that
 * wrap a quoted sentence — is never answer bytes, so comparison reads through it:
 * `bukan **fatwa**` and `"bukan fatwa"` carry the same words.
 */
const WRAP_ONLY = /[*_~`"'“”‘’]+/g;

/** The marker prefix a disclaimer sentence may carry; it is not answer content. */
const MARKER_PREFIX =
  /^(?:\[\s*(?:peringatan|warning|catatan|note)\s*\]|(?:peringatan|warning|catatan|note)\s*:)\s*/iu;

/** The punctuation run that ends a sentence, in either script. */
const TERMINAL_PUNCTUATION = /[.!?؟۔]+$/u;

/** A unit's comparison tokens — normalisation that exists only to compare, never to
 * rewrite: wrap-only markup and a leading rule marker go, case folds, whitespace
 * collapses, and the terminal punctuation run goes. Every other character stays, so
 * two units compare equal only when they carry the same words in the same order. */
function comparisonTokens(text: string): string[] {
  let normalised = text.replace(WRAP_ONLY, "");
  for (;;) {
    const next = normalised.replace(MARKER_PREFIX, "");
    if (next === normalised) break;
    normalised = next;
  }
  return normalised
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .replace(TERMINAL_PUNCTUATION, "")
    .split(" ")
    .filter((token) => token !== "");
}

/** Every sentence the rule may delete, one literal token sequence each — the canonical
 * copy in both languages, and the paraphrase shapes delivered answers actually carried:
 * the claim alone, and the claim with the consult instruction the copy pairs with it.
 * The set is closed: a sentence outside it is answer content, and widening it is how a
 * rule that misreads a word regains the power to delete a sentence. */
const DISCLAIMER_TEMPLATES: readonly (readonly string[])[] = [
  ulamaDisclaimer("id"),
  ulamaDisclaimer("en"),
  "Jawaban ini bukan fatwa.",
  "Jawaban ini bukan fatwa; rujuk ulama.",
  "Jawaban ini bukan fatwa; ruklah ulama.",
  "Jawaban ini bukan fatwa; untuk keputusan hukum, silakan merujuk kepada ulama.",
  "Jawaban ini bukan suatu fatwa; rujuk ulama.",
  "This answer is not a fatwa.",
  "This answer is not a fatwa; for legal rulings, please consult a scholar.",
  "This is not a legal fatwa; ask a scholar.",
  "This is not meant to be a fatwa; ask a scholar.",
].map(comparisonTokens);

/** True when two token sequences carry the same tokens, in the same order. */
function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

/** True when the unit's comparison tokens are exactly a template's — token for token,
 * never a substring, a frame, or "starts with a subject". Any token the template does
 * not have makes the unit answer content, and the rule keeps it. */
function isDisclaimerTemplate(unit: string): boolean {
  const tokens = comparisonTokens(unit);
  return tokens.length > 0 && DISCLAIMER_TEMPLATES.some((template) => sameTokens(tokens, template));
}

/** The units a disclaimer can occupy. A sentence ends at terminal punctuation in either
 * script plus any markup that closes it — a quotation mark, a bracket, a table pipe, a
 * wrap delimiter — because none of those is answer text, and a boundary that stopped
 * inside one would merge the next sentence into the unit and delete it with the
 * disclaimer. A paragraph break is a unit boundary too, and the split keeps the
 * separators so everything the rule does not remove survives byte-for-byte. */
const DISCLAIMER_UNITS = /([.!?؟۔]+["'”’)\]*_~`|]*)(?=\s|$)/;

/** Runs of the wrap-only markdown a sentence may carry; never answer bytes. */
const WRAP_RUNS = /\*+|_+|~+|`+/g;

/** Drop every unit that is, token for token, one of the disclaimer templates, keeping the
 * other bytes; a unit that matches no template is kept whole. When the removed unit
 * opened a markdown wrap the paragraph closes later, the closing run survives as the
 * paragraph's only run of its marker — an orphaned delimiter, not answer text — and is
 * removed with it. */
function dropDisclaimerUnits(paragraph: string): string {
  const units = paragraph.split(DISCLAIMER_UNITS);
  const opening = /^\s*([*_~`]+)/.exec(paragraph)?.[1] ?? "";
  const openingDropped = isDisclaimerTemplate(units[0] ?? "");
  let kept = "";
  for (let i = 0; i < units.length; i += 2) {
    if (isDisclaimerTemplate(units[i] ?? "")) continue;
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

/** Remove every unit that is, token for token, one of the disclaimer templates, so the
 * copy the rule appends sits at the close the renderer peels. Every other unit is kept
 * byte-for-byte — a paraphrase outside the set, a dhaif note, a table row, a sentence
 * using the claim in another sense — and a paragraph the removal empties is dropped. */
function withoutDisclaimer(text: string): string {
  let changed = false;
  const paragraphs: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const kept = dropDisclaimerUnits(paragraph);
    changed ||= kept !== paragraph;
    const trimmed = kept.trim();
    if (trimmed === "") continue;
    paragraphs.push(kept === paragraph ? paragraph : trimmed);
  }
  return changed ? paragraphs.join("\n\n") : text;
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
  // The disclaimer's wording is the rule's. Clearing the units that equal a template
  // before anything is appended makes the canonical copy the answer's close; every
  // other unit stays byte-for-byte, so the copy can sit beside a paraphrase but never
  // instead of it.
  const body = withoutDisclaimer(draft.text);
  const parts: string[] = body === "" ? [] : [body];

  const weak = weakGradeScope(context.chunks);
  if (weak !== null && !hasWeakWarning(body)) {
    // The copy names the trigger: a weak row on one sanad is not the same claim
    // as a passage graded weak, and the sheet beside this card may render both.
    parts.push(weak === "passage" ? dhaifWarning(language) : dhaifChainWarning(language));
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
