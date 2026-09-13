import type { ChatCitation } from "@app/contracts";

/**
 * Rendering rules for an assistant answer (#11). The citation payload comes
 * from the server's structured frame — this module never decides what IS a
 * citation (no grammar parsing): it only LOCATES the frame's labels in the
 * answer text so they render as chips. The dhaif warning and the ulama
 * disclaimer are split out of the text into their own blocks by matching the
 * product's canonical copy (kajianq-domain's chat-postprocess constants —
 * drift is guarded by chat-render.test.ts, which imports both sides).
 *
 * Inline markdown (#150): the grounded model still spontaneously wraps spans
 * in `**bold**` / `*emphasis*` and emits `- ` / `1. ` lists, and the answer
 * card must render them as rich text, never as literal markers. This is a
 * display-only concern — citation extraction runs on the raw text upstream
 * and is unaffected.
 */

/** The machine-translation label (ADR-0006) — one Indonesian constant, no EN variant. */
export const MACHINE_TRANSLATION_LABEL = "Terjemahan mesin — lihat teks Arab asli";

/**
 * The rule-block markers the deterministic postprocess writes (stable
 * product vocabulary — the warning's bracket marker, the disclaimer's
 * "bukan fatwa" invariant phrase, the same phrases the postprocess itself
 * matches on). Block-splitting matches these PREFIXES, not the full copy,
 * so wording tweaks cannot silently stop the blocks from peeling.
 */
export const WARNING_MARKERS = ["[Peringatan]", "[Warning]"] as const;
export const DISCLAIMER_MARKERS = [
  "Jawaban ini bukan fatwa",
  "This answer is not a fatwa",
] as const;

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
  /** The answer text without its trailing warning/disclaimer paragraphs. */
  body: string;
  /** The canonical dhaif warning, when the text carries it. */
  warning: string | null;
  /** The canonical ulama disclaimer, when the text closes with it. */
  disclaimer: string | null;
};

/**
 * Peel the deterministic rule paragraphs off an answer: the dhaif warning
 * and the disclaimer render as their own visually distinct blocks (spec
 * §2.2), never as ordinary prose. Matching is exact-equality on the product's
 * own copy — our strings, not the model's phrasing.
 */
export function splitAnswerBlocks(text: string): SplitAnswer {
  const paragraphs = text.split("\n\n");
  let disclaimer: string | null = null;
  let warning: string | null = null;
  const takeIfMarked = (paragraph: string, markers: readonly string[]): string | null => {
    const trimmed = paragraph.trim();
    return trimmed.length <= RULE_LINE_MAX && markers.some((m) => trimmed.startsWith(m))
      ? trimmed
      : null;
  };
  if (paragraphs.length > 0) {
    const last = paragraphs[paragraphs.length - 1]!;
    disclaimer = takeIfMarked(last, DISCLAIMER_MARKERS);
    if (disclaimer !== null) paragraphs.pop();
  }
  if (paragraphs.length > 0) {
    const last = paragraphs[paragraphs.length - 1]!;
    warning = takeIfMarked(last, WARNING_MARKERS);
    if (warning !== null) paragraphs.pop();
  }
  return { body: paragraphs.join("\n\n"), warning, disclaimer };
}
