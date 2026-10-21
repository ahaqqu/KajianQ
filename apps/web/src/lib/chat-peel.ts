import { peelMarkupLayer } from "./chat-markup";
import { messages } from "./i18n-messages";

/**
 * The rule-peel half of the answer renderer: the deterministic rule paragraphs the
 * postprocess appends — the dhaif warning, the machine-translation label and the ulama
 * disclaimer — are peeled into their own display blocks. `chat-render.ts` keeps the
 * markdown/inline half and re-exports this surface; the copy pair is pinned by
 * `tests/parity/chat-rule-copy.test.mjs`.
 */

/** The machine-translation label (ADR-0006) — one Indonesian constant, no EN variant. */
export const MACHINE_TRANSLATION_LABEL = "Terjemahan mesin — lihat teks Arab asli";

/**
 * The rule-block vocabulary the deterministic postprocess writes. Only a marker's OPENING
 * is matched, never the copy after it — `opensWith` states how wide that is.
 */
export const WARNING_MARKERS = ["[Peringatan]", "[Warning]"] as const;
export const DISCLAIMER_MARKERS = [
  "Jawaban ini bukan fatwa",
  "This answer is not a fatwa",
] as const;

/** The dhaif lines the peel treats as the product's own copy — both locales' i18n copy,
 * because an answer keeps its generated language while a UI language switch must still
 * render its line once. Marker-prefixed prose is not a line here and stays prose. */
const CANONICAL_WARNINGS: readonly string[] = [
  messages.en.dhaifWarningCard,
  messages.id.dhaifWarningCard,
];

/** A rule paragraph is one short line; anything longer is answer prose. */
const RULE_LINE_MAX = 200;

export type SplitAnswer = {
  body: string;
  /** The product's canonical dhaif line — the card's only grade-warning copy. */
  warning: string | null;
  /** The canonical ulama disclaimer, when the text closes with it. */
  disclaimer: string | null;
};

/** The MT label's head, before its em-dash detail: the peel matches this head, bracket
 * optional, so a wording tweak inside the label cannot stop the walk. */
const MACHINE_TRANSLATION_HEAD = MACHINE_TRANSLATION_LABEL.split(" — ")[0]!;

/** True when `paragraph` opens with `marker`: `bracketed` requires the leading bracket,
 * comparison is case-insensitive, and the character after the marker is unconstrained. */
function opensWith(paragraph: string, marker: string, bracketed: boolean): boolean {
  if (bracketed && !paragraph.startsWith("[")) return false;
  const name = marker.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  const opening = paragraph.startsWith("[") ? paragraph.slice(1).trimStart() : paragraph;
  return opening.toLowerCase().startsWith(name);
}

/** Where a rule paragraph peels: a `SplitAnswer` field, or `null` for `body`. */
type RuleField = "warning" | "disclaimer" | null;

type RuleKind = {
  field: RuleField;
  matches: (paragraph: string) => boolean;
};

/** The rule kinds, in match order: the walk follows the kind this table returns, so a rule
 * paragraph never terminates it — only prose does. */
const RULE_KINDS: readonly RuleKind[] = [
  { field: "warning", matches: (p) => WARNING_MARKERS.some((m) => opensWith(p, m, true)) },
  { field: "disclaimer", matches: (p) => DISCLAIMER_MARKERS.some((m) => opensWith(p, m, false)) },
  // Peels into no field: machine-translation provenance stays in `body`, in order.
  { field: null, matches: (p) => opensWith(p, MACHINE_TRANSLATION_HEAD, false) },
];

/** The canonical lines `text` carries, in `CANONICAL_WARNINGS` order. */
function canonicalCopiesIn(text: string): string[] {
  return CANONICAL_WARNINGS.filter((copy) => text.includes(copy));
}

/** `text` with every canonical line removed; every other byte stays as written. */
function removeCanonicalCopies(text: string): string {
  let remainder = text;
  for (const copy of canonicalCopiesIn(text)) remainder = remainder.replaceAll(copy, "");
  return remainder;
}

/** True when `text` is nothing but occurrences of `line` separated by whitespace — a repeat
 * of one line, whether space- or newline-separated. */
function isOnlyRepeatsOf(text: string, line: string): boolean {
  return text.includes(line) && text.replaceAll(line, "").trim() === "";
}

/** The one canonical copy `text` is made of, whitespace aside, or `null`. A repeat is still
 * one copy: both `copy copy` on a line and `copy\ncopy` in a paragraph qualify. Two locales
 * in one text match neither copy, so the card can never drop a literal it does not draw. */
function copyOf(text: string): string | null {
  return CANONICAL_WARNINGS.find((copy) => isOnlyRepeatsOf(text, copy)) ?? null;
}

/** True when `line` is one of the product's own rule lines — the MT label or the
 * disclaimer — so a paragraph's remainder after the copy is stripped is product copy, never
 * the model's words. A marker-prefixed prose line is not one: it is the model's sentence. */
function isProductRuleLine(line: string): boolean {
  const text = line.trim();
  return (
    opensWith(text, MACHINE_TRANSLATION_HEAD, false) ||
    DISCLAIMER_MARKERS.some((marker) => opensWith(text, marker, false))
  );
}

/** The line's content once every layer of wrap-only markup is peeled, or `null` when the
 * line carries none. A line that opens with markup but does not close it stays as the text
 * the peel reached, which the copy check then rejects. */
function peelWrapOnly(line: string): string | null {
  let text = line.trim();
  let peeled = false;
  for (;;) {
    const next = peelMarkupLayer(text);
    if (next === null) return peeled ? text : null;
    peeled = true;
    text = next;
  }
}

/** One line's disposition inside a paragraph that carries the canonical copy: the copy the
 * card draws (`drop`), product rule copy that stays (`keep`, with the bytes to keep), or the
 * model's own content (`reject`). */
type CopyLine = { kind: "drop" } | { kind: "keep"; bytes: string } | { kind: "reject" };

/** Classify one line of a copy paragraph. Wrap-only markup is peeled before the line is read
 * — the markers the renderer draws are not content — so a copy the model wrapped is still
 * the card's line, while a copy written into its own sentence, or left under a marker that is
 * not the copy, rejects the paragraph. Product rule copy keeps its own bytes, with the copy
 * removed and nothing else.
 */
function classifyCopyLine(line: string): CopyLine {
  const content = peelWrapOnly(line) ?? line.trim();
  if (copyOf(content) !== null) return { kind: "drop" };
  // Product rule copy keeps its bytes whether it sits alone, behind wrap-only markers, or
  // shares the line with the copy (the p9d interleave): what stays is the raw line with the
  // copies removed, never a trimmed rewrite of it.
  const withoutCopy = removeCanonicalCopies(line).trim();
  if (isProductRuleLine(content) || isProductRuleLine(withoutCopy)) {
    // A line that carried the copy keeps its own bytes around it; a rule line that carried
    // none keeps its indentation and markers exactly as written.
    const bytes = canonicalCopiesIn(line).length > 0 ? withoutCopy : line.trimEnd();
    return bytes === "" ? { kind: "drop" } : { kind: "keep", bytes };
  }
  return { kind: "reject" };
}

/** The canonical copy a paragraph carries and the bytes that stay in `body`, or `null` when
 * the paragraph is prose. One walk over the paragraph's lines: a line is a copy the peel
 * drops, product rule copy it keeps, or the model's content, which rejects the paragraph
 * whole. A paragraph carrying both locales is prose too — dropping one literal while the
 * card draws the other would render it zero times — so it keeps every byte. */
function splitCanonicalCopy(paragraph: string): { copy: string; remainder: string } | null {
  const copies = canonicalCopiesIn(paragraph);
  if (copies.length !== 1) return null;
  const kept: string[] = [];
  for (const line of paragraph.split("\n")) {
    if (line.trim() === "") continue;
    const disposition = classifyCopyLine(line);
    if (disposition.kind === "reject") return null;
    if (disposition.kind === "keep") kept.push(disposition.bytes);
  }
  return { copy: copies[0]!, remainder: kept.join("\n") };
}

/** Classify one paragraph as a rule line (`kind` + trimmed text) or `null` for prose. Short
 * lines only — except the canonical copy, whose equality counts and whose byte-identical
 * repeats collapse to the one copy the card draws. */
function classifyRule(paragraph: string): { kind: RuleKind; text: string } | null {
  const repeat = copyOf(paragraph);
  const text = repeat ?? paragraph.trim();
  if (text.length > RULE_LINE_MAX && !CANONICAL_WARNINGS.includes(text)) return null;
  const kind = RULE_KINDS.find((candidate) => candidate.matches(text));
  return kind === undefined ? null : { kind, text };
}

/**
 * Peel the deterministic rule paragraphs off an answer: the dhaif warning and the disclaimer
 * render as their own blocks, never as ordinary prose.
 * The peel walks the whole consecutive trailing run, because the postprocess appends
 * warning → MT label → disclaimer and a shorter peel would leave the warning in `body`. Each
 * kind dispatches once:
 * - **warning**: peels only when it equals the product's canonical line (`CANONICAL_WARNINGS`),
 *   so marker-prefixed prose stays prose; a repeat is dropped as the card renders it once.
 *   The canonical line is taken **wherever the paragraph sits**, not only in the trailing run,
 *   and out of a paragraph that also carries product rule copy (the MT label, the disclaimer)
 *   or only wrap-only markup (`**`, `_`, `*`, `- `, `* `, `1. `, `> `): the postprocess
 *   suppresses its own append when the draft already carries the copy, so a mid-answer copy is
 *   the same line the card draws and would otherwise render twice. Wrap delimiters are not
 *   answer bytes, so a wrap-only paragraph goes whole; product rule copy's bytes stay in
 *   `body`. A different canonical literal (the other locale) is never dropped.
 * - **disclaimer**: peels into its footer whatever `bukan fatwa` phrasing opens it, so a
 *   model paraphrase that reached a persisted transcript still renders a footer rather than
 *   prose; an identical repeat is dropped, a different one stays.
 * - **MT label**: peels into no field and stays in `body`, in order, with the text it describes.
 * - anything else stops the walk, so prose is never eaten; only a repeat of copy the card still
 *   renders is dropped.
 */
export function splitAnswerBlocks(text: string): SplitAnswer {
  const paragraphs = text.split("\n\n");
  const kept: string[] = []; // rule paragraphs that stay in the body, right-to-left
  let warning: string | null = null;
  let disclaimer: string | null = null;
  let cut = paragraphs.length; // first index of the trailing rule run
  for (let i = paragraphs.length - 1; i >= 0; i -= 1) {
    const rule = classifyRule(paragraphs[i]!);
    if (rule === null) break;
    cut = i;
    if (rule.kind.field === "warning") {
      if (warning === null && CANONICAL_WARNINGS.includes(rule.text)) warning = rule.text;
      else if (rule.text !== warning) kept.push(rule.text); // marker prose, not a trust line
    } else if (rule.kind.field === "disclaimer") {
      // The copy can ride the footer's own line; the card renders it once, so strip it here
      // too rather than letting the footer draw a second copy — but only the literal the card
      // draws: a different one stays in the footer so it never renders zero times.
      const copies = canonicalCopiesIn(rule.text);
      const strip = copies.length === 1 && (warning === null || warning === copies[0]);
      if (strip) warning = copies[0]!;
      const text = strip ? removeCanonicalCopies(rule.text).trim() : rule.text;
      if (text === "") continue;
      if (disclaimer === null) disclaimer = text;
      else if (text !== disclaimer) kept.push(text);
    } else {
      kept.push(rule.text);
    }
  }
  // Every paragraph that carries the product's canonical copy is the line the
  // card draws — above the trailing run and among the rule paragraphs the walk
  // kept in the body. Peel the copy out wherever it sits: a sole-copy paragraph
  // goes entirely, and a paragraph whose remainder is product rule copy (the MT
  // label, the disclaimer) keeps that remainder byte-identical in place. A
  // remainder that is only repeats of the footer's own disclaimer line goes too,
  // because the footer draws that line once. Prose that merely opens with a
  // marker, or mixes the copy with the model's own words, is not that line and
  // stays whole.
  const body: string[] = [];
  for (const paragraph of [...paragraphs.slice(0, cut), ...kept.reverse()]) {
    const copy = splitCanonicalCopy(paragraph);
    // Drop only the literal the card already draws: a different canonical copy
    // stays whole so no delivered sentence renders zero times.
    if (copy === null || (warning !== null && warning !== copy.copy)) {
      body.push(paragraph);
    } else {
      warning = copy.copy;
      // Needs a footer the walk already peeled: the delivered answer's closing
      // disclaimer paragraph. A remainder that only repeats that line is the same
      // sentence and is dropped with the repeat; a paraphrase that differs by a
      // byte is the model's sentence and stays.
      if (disclaimer !== null && isOnlyRepeatsOf(copy.remainder, disclaimer)) continue;
      if (copy.remainder !== "") body.push(copy.remainder);
    }
  }
  return {
    body: body.join("\n\n"),
    warning,
    disclaimer,
  };
}
