/**
 * The one markdown grammar the answer renderer and the rule peel share: the inline emphasis
 * spans and the line markers the card turns into rich text. `chat-render.ts` builds its
 * display blocks from it and `chat-peel.ts` recognises wrap-only markup around a rule copy
 * with it, so a delimiter the card draws can never be invisible to the peel.
 */

/** The inline emphasis delimiters the card renders, longest first: `***` is bold italic,
 * `**` bold, `*` and `_` emphasis. */
export const INLINE_DELIMITERS = ["***", "**", "*", "_"] as const;

export type InlineDelimiter = (typeof INLINE_DELIMITERS)[number];

/** Each delimiter's span branch: one capture for the content, plus the guards that keep
 * `2 * 3 = 6` and `snake_case` verbatim. The `Record` makes a token without a branch a type
 * error, so the grammar cannot grow a delimiter one half ignores. */
const STYLED_SPAN_BRANCH: Record<InlineDelimiter, string> = {
  "***": String.raw`\*\*\*([^*\s](?:[^*]*[^*\s])?)\*\*\*`,
  "**": String.raw`\*\*([^*\s](?:(?:\*(?!\*)|[^*])*[^*\s])?)\*\*`,
  "*": String.raw`(?<!\w)\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)`,
  _: String.raw`(?<!\w)_([^_\s](?:[^_]*[^_\s])?)_(?!\w)`,
};

/** A styled span: bold italic, then bold (whose content may carry non-adjacent single
 * asterisks, so `**a *b* c**` nests the emphasis instead of leaking its markers), then
 * emphasis, then underscore emphasis. */
export const STYLED_SPAN = new RegExp(
  INLINE_DELIMITERS.map((delimiter) => STYLED_SPAN_BRANCH[delimiter]).join("|"),
);

/** The list-marker vocabulary both halves read: a `-` / `*` bullet or an ordered `1.` / `1)`
 * number. */
const BULLET = "[-*]";
const ORDERED = String.raw`\d{1,9}[.)]`;

/** A list line: an optional 3-space indent, then a bullet (group 1) or an ordered marker
 * (group 2), then the item text (group 3). */
export const LIST_LINE = new RegExp(String.raw`^ {0,3}(?:(${BULLET})|(${ORDERED}))\s+(.+)$`);

/** A line's leading markers — a blockquote, or a bullet/ordered marker, nested in any order
 * (`> - 1. `) — which the peel strips before reading a line as rule copy. */
export const LINE_MARKERS = new RegExp(
  String.raw`^[ \t]*(?:>[ \t]*|(?:${BULLET}|${ORDERED})[ \t]+)+`,
);

/** Peel one layer of wrap-only markup off `text`: a line's leading markers, or a symmetric
 * emphasis pair around its content (the pair may repeat, so `__x__` peels one underscore at a
 * time). `null` when the text opens with neither. */
export function peelMarkupLayer(text: string): string | null {
  const unPrefixed = text.replace(LINE_MARKERS, "").trim();
  if (unPrefixed !== text) return unPrefixed;
  for (const delimiter of INLINE_DELIMITERS) {
    if (text.length <= delimiter.length * 2) continue;
    if (text.startsWith(delimiter) && text.endsWith(delimiter)) {
      return text.slice(delimiter.length, text.length - delimiter.length).trim();
    }
  }
  return null;
}
