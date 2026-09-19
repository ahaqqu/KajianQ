import * as v from "valibot";

/**
 * The chat route's query-param pre-fill (#175). The collection page's
 * "Ask about this source" affordance links to `/?q=<question>`; the chat route
 * reads that param once, seeds the composer draft with it, and strips it from
 * the URL (see `ChatPage`). The pinned semantics live here for the parsing half
 * and in `ChatView` for the draft half:
 *
 *  - The param is a DRAFT SEED ONLY — never auto-sent. Nothing about a turn
 *    changes and no request is made because of it: the pre-fill never touches
 *    the chat session/server contract (ADR-0040) and the composer stays
 *    local-only.
 *  - A usable `q` is consumed on first read (`history.replaceState`, via the
 *    router), so a refresh of the chat does not re-seed an old question.
 *  - An absent, empty, whitespace-only, non-string or over-long `q` is
 *    IGNORED: it never seeds, and it never errors — an out-of-range param is
 *    never a route-search error.
 *  - A draft the reader has already edited is never clobbered: the seed applies
 *    only while the draft is still empty (`ChatView`).
 */

/**
 * The seed question's length cap. A question is a sentence, not a document;
 * the cap keeps the URL sane and bounds what a crafted link can paste into the
 * composer (issue #175). Anything longer is ignored, not truncated.
 */
export const MAX_PREFILL_LENGTH = 200;

/** The validated search of the chat route ("/"): an optional seed question. */
export type ChatSearch = { q?: string | undefined };

const PrefillSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_PREFILL_LENGTH));

/**
 * The seed question carried by a raw `q` value, or `undefined` when the value is
 * absent or unusable (empty, whitespace-only, not a string, or longer than
 * `MAX_PREFILL_LENGTH`). Never throws: an unusable param is ignored, not an
 * error. A usable one is trimmed, so the composer never opens on stray space.
 */
export function parsePrefill(raw: unknown): string | undefined {
  const parsed = v.safeParse(PrefillSchema, raw);
  return parsed.success ? parsed.output : undefined;
}

/**
 * The chat route's `validateSearch`. Every input maps to a valid `ChatSearch`:
 * a usable question becomes `{ q }`, anything else becomes `{ q: undefined }` —
 * so a malformed or out-of-range param degrades to "no pre-fill" instead of
 * failing the route (issue #175).
 *
 * The output ALWAYS carries the `q` key, explicitly undefined when the param is
 * unusable: TanStack merges the validated object OVER the raw, unparsed search
 * (`matchRoutes`, `applySearchMiddleware`), so a key omitted from the output
 * would leave the raw value — including a junk one like `"   "` — readable via
 * `useSearch`. Emitting `q: undefined` is what clears it.
 */
export function validateChatSearch(input: Record<string, unknown>): ChatSearch {
  return { q: parsePrefill(input["q"]) };
}
