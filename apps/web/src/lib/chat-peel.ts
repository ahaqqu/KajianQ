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

/** The canonical dhaif line this paragraph repeats, or `null` when it is not a repeat. The
 * test is a copy remainder, not a line split: drop every occurrence of a canonical line and
 * require whitespace only, so copy mixed with the model's own words stays prose, whole. */
function repeatOfCanonicalWarning(paragraph: string): string | null {
  return (
    CANONICAL_WARNINGS.find(
      (copy) => paragraph.includes(copy) && paragraph.replaceAll(copy, "").trim() === "",
    ) ?? null
  );
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

/** The wrap-only line prefix a model puts before a copy: an optional indent, then blockquote
 * markers and a bullet, nested in any order (`> - `). A `*` with no space after it is an
 * inline emphasis delimiter, not a bullet. */
const LINE_WRAP_PREFIX = /^[ \t]*(?:(?:>[ \t]*)|(?:[-*][ \t]+))+/;

/** The inline emphasis delimiters the card renders, longest first: `***` is bold italic,
 * `**` bold, `*` and `_` emphasis. */
const INLINE_WRAPS = ["***", "**", "*", "_"] as const;

/** Every canonical line removed from `text`, with the copy to treat as the card's value, or
 * `null` when the text carries none. The remainder keeps every other byte, so product rule
 * copy embedded in a rule value never draws the sentence twice. */
function stripCanonicalCopy(text: string): { copy: string; remainder: string } | null {
  const copies = CANONICAL_WARNINGS.filter((copy) => text.includes(copy));
  if (copies.length === 0) return null;
  let remainder = text;
  for (const copy of copies) remainder = remainder.replaceAll(copy, "");
  return { copy: copies[0]!, remainder: remainder.trim() };
}

/** Peel one layer of wrap-only markup off `text`: a line prefix, or a symmetric emphasis pair
 * around its content (the pair may repeat, so `__x__` peels one underscore at a time).
 * `null` when the text opens with neither. */
function peelWrapLayer(text: string): string | null {
  const unPrefixed = text.replace(LINE_WRAP_PREFIX, "").trim();
  if (unPrefixed !== text) return unPrefixed;
  for (const wrap of INLINE_WRAPS) {
    if (text.length <= wrap.length * 2) continue;
    if (text.startsWith(wrap) && text.endsWith(wrap)) {
      return text.slice(wrap.length, text.length - wrap.length).trim();
    }
  }
  return null;
}

/** The line's content once every layer of wrap-only markup is peeled, or `null` when the
 * line carries none. A line that opens with markup but does not close it stays as the text
 * the peel reached, which no canonical copy equals. */
function peelWrapOnly(line: string): string | null {
  let text = line.trim();
  let peeled = false;
  for (;;) {
    const next = peelWrapLayer(text);
    if (next === null) return peeled ? text : null;
    peeled = true;
    text = next;
  }
}

/** When every line of `paragraph` is a canonical copy under wrap-only markup, or product rule
 * copy, the copy the card draws arrived wrapped: return the product rule copy that stays in
 * `body` byte-identical, or `null` when any line carries the model's own words. Stripping a
 * wrap-only copy loses no answer bytes — the copy goes to the card and its delimiters with
 * it — so this is the one paragraph the peel empties without touching a word it renders. */
function wrapOnlyRemainder(paragraph: string, copy: string): string | null {
  const kept: string[] = [];
  let carried = false;
  for (const line of paragraph.split("\n")) {
    if (line.trim() === "") continue;
    if (isProductRuleLine(line)) {
      const stripped = stripCanonicalCopy(line);
      const remainder = stripped === null ? line.trim() : stripped.remainder;
      if (remainder !== "") kept.push(remainder);
      continue;
    }
    const bare = stripCanonicalCopy(line);
    if (bare !== null && bare.remainder === "") {
      carried = true; // the line is nothing but copies
      continue;
    }
    if (peelWrapOnly(line) !== copy) return null;
    carried = true;
  }
  return carried ? kept.join("\n") : null;
}

/** The canonical copy a paragraph carries and what is left of it once every copy is removed:
 * the remainder must be blank, product rule copy only, or wrap-only markup around the copy,
 * so stripping the copy drops no answer content and the bytes that stay are byte-identical in
 * `body`. `null` when the paragraph carries no copy, or what remains is the model's own words
 * — that paragraph is prose and stays whole. Both directions read the one
 * `CANONICAL_WARNINGS` set. */
function splitCanonicalCopy(paragraph: string): { copy: string; remainder: string } | null {
  const stripped = stripCanonicalCopy(paragraph);
  if (stripped === null || stripped.remainder === "") return stripped;
  const lines = stripped.remainder.split("\n").filter((line) => line.trim() !== "");
  if (lines.every(isProductRuleLine)) return stripped;
  const remainder = wrapOnlyRemainder(paragraph, stripped.copy);
  return remainder === null ? null : { copy: stripped.copy, remainder };
}

/** Classify one paragraph as a rule line (`kind` + trimmed text) or `null` for prose. Short
 * lines only — except the canonical copy, whose equality counts and whose byte-identical
 * repeats collapse to the one copy the card draws. */
function classifyRule(paragraph: string): { kind: RuleKind; text: string } | null {
  const repeat = repeatOfCanonicalWarning(paragraph);
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
 *   or only wrap-only markup (`**`, `_`, `*`, `- `, `* `, `> `): the postprocess suppresses
 *   its own append when the draft already carries the copy, so a mid-answer copy is the same
 *   line the card draws and would otherwise render twice. Wrap delimiters are not answer
 *   bytes, so a wrap-only paragraph goes whole; product rule copy's bytes stay in `body`.
 * - **disclaimer**: peels into its footer whatever `bukan fatwa` phrasing opens it (the
 *   server's loose predicate); an identical repeat is dropped, a different one stays.
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
      // The copy can ride the footer's own line; the card renders it once, so
      // strip it here too rather than letting the footer draw a second copy.
      const stripped = stripCanonicalCopy(rule.text);
      if (stripped !== null) warning ??= stripped.copy;
      const text = stripped?.remainder ?? rule.text;
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
  // label, the disclaimer) keeps that remainder byte-identical in place. Prose
  // that merely opens with a marker, or mixes the copy with the model's own
  // words or markup, is not that line and stays whole.
  const body: string[] = [];
  for (const paragraph of [...paragraphs.slice(0, cut), ...kept.reverse()]) {
    const copy = splitCanonicalCopy(paragraph);
    if (copy === null) {
      body.push(paragraph);
    } else {
      warning ??= copy.copy;
      if (copy.remainder !== "") body.push(copy.remainder);
    }
  }
  return {
    body: body.join("\n\n"),
    warning,
    disclaimer,
  };
}
