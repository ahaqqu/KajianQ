/**
 * The one admission a text passes before it becomes a Sub-query (#450, #462):
 * trim it, then ask whether it carries anything a search can match.
 *
 * It lives apart from `chat-router-decompose` because it has more than one
 * caller — the repair's `push`, and the router's fallback, a third origin a
 * caller's text reaches the fan-out from — and the invariant it owns is stated
 * without an origin: **whatever** offered the text, one carrying no letter and
 * no digit never becomes a sub-query. One owner for the test, so the fallback
 * cannot drift from the stage again (review A1 of #462).
 *
 * Trimming is not a drop: padded text is the same query, kept trimmed. The two
 * halves travel together, because a caller that applies the content test
 * without the trim publishes `"  riba  "` on the Trace and hands the same
 * padding to the embed while the decomposer publishes `"riba"` for the one text
 * (`SPECS.md` §3.3: "padded text is kept trimmed").
 */

/**
 * The admission, whole: the text trimmed, or `undefined` when it is not a query
 * at all. The content-free classes — whitespace, punctuation, an emoji, a `Cf`
 * zero-width space or joiner, a `Cc` control, any mix of them — fail it, and a
 * text that fails it is never embedded, never searched and never published as a
 * `subquery` event.
 */
export function admitSubQueryText(text: string): string | undefined {
  const trimmed = text.trim();
  return hasSearchableContent(trimmed) ? trimmed : undefined;
}

/**
 * Does this text carry anything a search can match? A letter or a digit in any
 * script — `\p{L}` and `\p{N}` are Unicode properties, so Arabic, Jawi, a bare
 * numeral and a single word all count. Anything else (whitespace, punctuation,
 * emoji, `Cf` zero-width characters and joiners, `Cc` control characters) is not
 * a query: the sparse track would tokenize nothing from it and the dense track
 * would return its nearest neighbours to noise, at the price of an embed and a
 * pair of searches (#450).
 */
export function hasSearchableContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
