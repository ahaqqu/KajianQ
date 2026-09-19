import type { Localized } from "./localized";

/**
 * The browser-storage line (#179 follow-up): what the app keeps ON the
 * visitor's device, stated plainly, so the notice's "anonymous and
 * local-first" claim is concrete rather than implied.
 *
 * Two facts the code backs, both pinned by `privacy-notice.test.ts` reading
 * the modules that implement them:
 *
 *   - **No cookies.** The app calls neither `document.cookie` nor any
 *     `Set-Cookie` header; the session token and the theme preference live in
 *     `localStorage` instead (`chat-store.ts` `TOKEN_KEY`, `theme.ts`
 *     `THEME_KEY`). Browser storage that is functional-only and carries no
 *     tracking is why no cookie-banner rules apply — so the notice says what
 *     is stored, not merely that nothing is.
 *   - **Erasable by the visitor, any time.** Clearing site data in the browser
 *     removes both keys without a request to the server. This is the local
 *     half of the erasure story; the server half is the endpoint the erasure
 *     card names, which is why this line links the two and does not restate
 *     the cascade.
 *
 * This is UI-posture copy, not register data: it names no processor, no
 * retention window, and no vendor, so it deliberately carries no row in
 * ADR-0043's register and needs none.
 */

export const STORAGE = {
  /** The `localStorage` keys the app writes, as the source modules define them. */
  keys: ["kajianq.auth.token", "kajianq.chat.sessionId", "kajianq.theme"],
  setsCookies: false,
  body: {
    id: "KajianQ tidak memasang cookie sama sekali. Token sesi dan preferensi tema disimpan di localStorage peramban Anda — murni fungsional, tanpa pelacakan, sehingga aturan banner cookie tidak berlaku. Anda dapat menghapusnya sendiri kapan saja lewat pengaturan data situs di peramban.",
    en: "KajianQ sets no cookies at all. The session token and your theme preference live in the browser's localStorage — functional only, with no tracking, which is why cookie-banner rules do not apply. You can erase them yourself at any time through your browser's site-data settings.",
  },
} as const satisfies { keys: readonly string[]; setsCookies: boolean; body: Localized };
