import type { ChatCitation } from "@app/contracts";
import { messages } from "./i18n-messages";

/**
 * Rendering rules for an assistant answer (#11). The citation payload comes
 * from the server's structured frame — this module never decides what IS a
 * citation (no grammar parsing): it only LOCATES the frame's labels in the
 * answer text so they render as chips. The dhaif warning and the ulama
 * disclaimer are split out into their own blocks by matching the product's
 * canonical copy; the client/server copy pair (the warning line, the ADR-0006
 * MT label, the marker vocabulary) is pinned by
 * `tests/parity/chat-rule-copy.test.mjs`, which imports both sides.
 *
 * Inline markdown (#150): the model still spontaneously wraps spans in
 * `**bold**` / `*emphasis*` and emits lists, and the card must render them as
 * rich text, never as literal markers. Display-only: citation extraction runs
 * on the raw text upstream and is unaffected.
 */

/** The machine-translation label (ADR-0006) — one Indonesian constant, no EN variant. */
export const MACHINE_TRANSLATION_LABEL = "Terjemahan mesin — lihat teks Arab asli";

/**
 * The rule-block vocabulary the deterministic postprocess writes (the warning's
 * bracket marker, the disclaimer's "bukan fatwa" invariant phrase — the same
 * phrases the postprocess matches on). Only a marker's OPENING is matched,
 * never the copy after it; `opensWith` states exactly how wide that is.
 */
export const WARNING_MARKERS = ["[Peringatan]", "[Warning]"] as const;
export const DISCLAIMER_MARKERS = [
  "Jawaban ini bukan fatwa",
  "This answer is not a fatwa",
] as const;

/**
 * The dhaif lines the peel treats as the product's own copy — both locales'
 * i18n copy, because an answer keeps the language it was generated in and a UI
 * language switch must still render its line once. Marker-prefixed prose
 * equals no line here and stays prose (A2); the parity spec pins both.
 */
const CANONICAL_WARNINGS: readonly string[] = [
  messages.en.dhaifWarningCard,
  messages.id.dhaifWarningCard,
];

/** A rule paragraph is one short line; anything longer is answer prose. */
const RULE_LINE_MAX = 200;

export type AnswerInline =
  | { kind: "text"; text: string }
  | { kind: "citation"; label: string }
  | { kind: "bold"; children: AnswerInline[] }
  | { kind: "em"; children: AnswerInline[] };

export type AnswerBlock =
  | { kind: "para"; inlines: AnswerInline[] }
  | { kind: "list"; ordered: boolean; items: AnswerInline[][] };

/**
 * A styled span's content must not start or end with whitespace (so
 * `2 * 3 = 6` stays arithmetic), and a one-asterisk emphasis must not open
 * or close against a word character (so `snake_case` and `3*4*5` stay
 * verbatim). Bold-italic (`***x***`) is tried first, then bold — whose
 * content may carry non-adjacent single asterisks, so `**a *b* c**` nests
 * the emphasis instead of leaking its markers — and bold is tried before
 * emphasis, so `**x**` never degrades to an emphasis pair around a lone `*`.
 */
const STYLED_SPAN =
  /\*\*\*([^*\s](?:[^*]*[^*\s])?)\*\*\*|\*\*([^*\s](?:(?:\*(?!\*)|[^*])*[^*\s])?)\*\*|(?<!\w)\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)|(?<!\w)_([^_\s](?:[^_]*[^_\s])?)_(?!\w)/;

/** A list line: an optional 3-space indent, then a `- `/`* ` bullet or a `1.`/`1)` number. */
const LIST_LINE = /^ {0,3}(?:([-*])|\d{1,9}[.)])\s+(.+)$/;

/**
 * Locate the frame's labels in a plain-text run: a chip replaces the whole
 * bracketed span `[label]` when present, else the bare label. A frame label
 * that does not occur in the text produces nothing — the text stays
 * verbatim, and no chip is invented.
 */
function locateCitations(text: string, citations: readonly ChatCitation[]): AnswerInline[] {
  const matches: { start: number; end: number; label: string }[] = [];
  for (const citation of citations) {
    for (const form of [`[${citation.label}]`, citation.label]) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(form, from);
        if (at === -1) break;
        matches.push({ start: at, end: at + form.length, label: citation.label });
        from = at + form.length;
      }
      if (matches.some((m) => m.label === citation.label)) break;
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const inlines: AnswerInline[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue; // overlapping — first (leftmost) wins
    if (match.start > cursor) {
      inlines.push({ kind: "text", text: text.slice(cursor, match.start) });
    }
    inlines.push({ kind: "citation", label: match.label });
    cursor = match.end;
  }
  if (cursor < text.length) inlines.push({ kind: "text", text: text.slice(cursor) });
  return inlines;
}

/**
 * Split a plain-text run into inline nodes: styled spans (`***bold italic***`,
 * `**bold**`, `*emphasis*`, `_emphasis_`) wrap the citation-aware parse of
 * their content — so `**[QS. 2:255]**` renders the chip inside bold — and
 * the gaps between them go through citation location directly. An unclosed
 * marker finds no span and stays verbatim text.
 */
export function parseInline(text: string, citations: readonly ChatCitation[]): AnswerInline[] {
  const match = STYLED_SPAN.exec(text);
  if (match === null) return locateCitations(text, citations);
  const inner = (match[1] ?? match[2] ?? match[3] ?? match[4])!;
  const children = parseInline(inner, citations);
  const bold = match[1] !== undefined || match[2] !== undefined;
  return [
    ...parseInline(text.slice(0, match.index), citations),
    bold
      ? {
          kind: "bold",
          children: match[1] !== undefined ? [{ kind: "em", children }] : children,
        }
      : { kind: "em", children },
    ...parseInline(text.slice(match.index + match[0].length), citations),
  ];
}

/**
 * Split the answer body into display blocks: consecutive list lines become
 * one `<ul>`/`<ol>` block, a blank line separates blocks, and every other
 * line run stays one paragraph (joined by `\n` — the card renders it
 * pre-wrap, so single newlines inside e.g. quoted Arabic keep their visual
 * breaks). An indented continuation line under a list item is not modeled:
 * it becomes its own paragraph.
 */
export function renderBodyBlocks(body: string, citations: readonly ChatCitation[]): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let paraLines: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushPara = () => {
    if (paraLines.length > 0) {
      blocks.push({ kind: "para", inlines: parseInline(paraLines.join("\n"), citations) });
      paraLines = [];
    }
  };
  const flushList = () => {
    if (list !== null) {
      blocks.push({
        kind: "list",
        ordered: list.ordered,
        items: list.items.map((item) => parseInline(item, citations)),
      });
      list = null;
    }
  };
  for (const line of body.split("\n")) {
    const listItem = LIST_LINE.exec(line);
    if (listItem !== null) {
      flushPara();
      const ordered = listItem[1] === undefined;
      if (list === null || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(listItem[2]!);
    } else if (line.trim() === "") {
      // A blank line separates blocks: it never renders as a leading or
      // trailing blank row inside a paragraph.
      flushList();
      flushPara();
    } else {
      flushList();
      paraLines.push(line);
    }
  }
  flushList();
  flushPara();
  return blocks;
}

export type SplitAnswer = {
  /** The answer text without the rule paragraphs the peel consumed. */
  body: string;
  /** The product's canonical dhaif line — the card's only grade-warning copy (A2). */
  warning: string | null;
  /** The canonical ulama disclaimer, when the text closes with it. */
  disclaimer: string | null;
};

/**
 * The MT label's head, before its em-dash detail — what a wording tweak inside
 * the label leaves alone. The peel matches this head, bracket optional, so the
 * tweak cannot stop the walk (#292); the parity spec pins the full label.
 */
const MACHINE_TRANSLATION_HEAD = MACHINE_TRANSLATION_LABEL.split(" — ")[0]!;

/**
 * True when `paragraph` opens with `marker`: the leading bracket is required
 * when `bracketed`, comparison is case-insensitive, and the character where the
 * marker ends is unconstrained — `[peringatan]`, `[Peringatan:`, `[Warning!]`
 * all classify. Nothing after the marker is inspected.
 */
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
  /** True when the trimmed paragraph is this kind of rule line. */
  matches: (paragraph: string) => boolean;
};

/**
 * The rule kinds, in match order. The walk follows the kind this table returns,
 * so a rule paragraph never terminates it — only prose does (#292).
 */
const RULE_KINDS: readonly RuleKind[] = [
  { field: "warning", matches: (p) => WARNING_MARKERS.some((m) => opensWith(p, m, true)) },
  { field: "disclaimer", matches: (p) => DISCLAIMER_MARKERS.some((m) => opensWith(p, m, false)) },
  // Peels into no field: ADR-0006 provenance that stays in `body`, in order.
  { field: null, matches: (p) => opensWith(p, MACHINE_TRANSLATION_HEAD, false) },
];

/**
 * Classify one paragraph as a rule line (`kind` + trimmed text) or `null` for
 * prose. Short lines only — except the canonical copy, whose equality counts;
 * a paragraph of byte-identical copies collapses to one, which the card draws
 * once, so its repeats are dropped with it and never reach `body` (#348).
 */
function classifyRule(paragraph: string): { kind: RuleKind; text: string } | null {
  const lines = paragraph.split("\n").map((line) => line.trim());
  const repeat = CANONICAL_WARNINGS.includes(lines[0]!) && lines.every((l) => l === lines[0]);
  const text = repeat ? lines[0]! : paragraph.trim();
  if (text.length > RULE_LINE_MAX && !CANONICAL_WARNINGS.includes(text)) return null;
  const kind = RULE_KINDS.find((candidate) => candidate.matches(text));
  return kind === undefined ? null : { kind, text };
}

/**
 * Peel the deterministic rule paragraphs off an answer: the dhaif warning
 * and the disclaimer render as their own visually distinct blocks (spec
 * §2.2), never as ordinary prose.
 *
 * The peel walks the *whole consecutive trailing run of rule paragraphs*, not
 * the last two (#292): the postprocess appends warning → MT label →
 * disclaimer, so the MT label is last on the common path and a two-pop peel
 * left the warning in `body` — drawn as prose *and* again by the card. Each
 * kind dispatches once:
 *
 * - the **warning** peels only when it equals the product's canonical line
 *   (`CANONICAL_WARNINGS`), so marker-prefixed model prose stays prose and can
 *   never become a trust card (A2); a byte-identical repeat of an already-
 *   peeled copy is dropped, because the card renders that copy once;
 * - the **disclaimer** peels into its footer whatever `bukan fatwa` phrasing
 *   opens it (the server's own loose predicate, #284); an identical repeat is
 *   dropped, a different one stays in `body`;
 * - the **MT label** peels into no field and stays in `body`, in order, so the
 *   provenance claim renders with the text it describes;
 * - anything else stops the walk, so prose is never eaten — and no paragraph is
 *   dropped except a repeat of copy the card still renders.
 */
export function splitAnswerBlocks(text: string): SplitAnswer {
  const paragraphs = text.split("\n\n");
  const kept: string[] = []; // rule paragraphs that stay in the body, right-to-left
  let warning: string | null = null;
  let disclaimer: string | null = null;
  let cut = paragraphs.length; // first index of the trailing rule run
  for (let i = paragraphs.length - 1; i >= 0; i -= 1) {
    const rule = classifyRule(paragraphs[i]!);
    if (rule === null) break; // answer prose ends the trailing run
    cut = i;
    if (rule.kind.field === "warning") {
      if (warning === null && CANONICAL_WARNINGS.includes(rule.text)) warning = rule.text;
      else if (rule.text !== warning) kept.push(rule.text); // marker prose, not a trust line
    } else if (rule.kind.field === "disclaimer") {
      if (disclaimer === null) disclaimer = rule.text;
      else if (rule.text !== disclaimer) kept.push(rule.text);
    } else {
      kept.push(rule.text);
    }
  }
  return {
    body: [...paragraphs.slice(0, cut), ...kept.reverse()].join("\n\n"),
    warning,
    disclaimer,
  };
}
