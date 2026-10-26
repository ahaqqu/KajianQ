import { HISTORY_KEY, SESSION_KEY, TOKEN_KEY } from "./chat-store";
import { CONSENT_KEY } from "./consent";
import type { Localized } from "./localized";
import { THEME_KEY } from "./theme";

/**
 * The browser-storage line: what the app keeps ON the visitor's device, stated
 * plainly, so the notice's "anonymous and local-first" claim is concrete rather
 * than implied.
 *
 * Two facts the code backs, both pinned by `privacy-notice.test.ts` reading
 * the modules that implement them:
 *
 *   - **No cookies.** The app calls neither `document.cookie` nor any
 *     `Set-Cookie` header; the session token, the conversation-history list, the
 *     consent choice and the theme preference live in `localStorage` instead
 *     (`chat-store.ts` `TOKEN_KEY`/`HISTORY_KEY`, `consent.ts` `CONSENT_KEY`,
 *     `theme.ts` `THEME_KEY`).
 *   - **Only after the reader agrees.** The chat keys are written by the store's
 *     consent gate (ADR-0063), so the list below is the granted state: before
 *     the answer, nothing but the theme preference is stored. Browser storage that is functional-only and carries no
 *     tracking is why no cookie-banner rules apply — so the notice says what
 *     is stored, not merely that nothing is.
 *   - **Erasable by the visitor, any time.** Clearing site data in the browser
 *     removes both keys without a request to the server. This is the local
 *     half of the erasure story; the server half is the endpoint the erasure
 *     card names, which is why this line links the two and does not restate
 *     the cascade.
 *
 * This is UI-posture copy, not register data: it names no processor, no
 * retention window, and no vendor, so it deliberately carries no row in the
 * Art. 30 record's register and needs none.
 */

export const STORAGE = {
  /** The `localStorage` keys the app writes, imported from the modules that
   * write them (`chat-store.ts`, `theme.ts`) — no duplicated literal to drift. */
  keys: [TOKEN_KEY, SESSION_KEY, HISTORY_KEY, CONSENT_KEY, THEME_KEY],
  setsCookies: false,
  body: {
    id: "KajianQ tidak memasang cookie sama sekali. Setelah Anda setuju menyimpan percakapan di peramban, token sesi, daftar percakapan, dan pilihan itu disimpan di localStorage bersama preferensi tema — murni fungsional, tanpa pelacakan, sehingga aturan banner cookie tidak berlaku. Sebelum Anda setuju, tidak ada yang disimpan selain preferensi tema. Anda dapat menghapusnya sendiri kapan saja, dan pilihan itu dapat diubah dari daftar riwayat percakapan.",
    en: "KajianQ sets no cookies at all. Once you agree to keep your conversation in this browser, the session token, the conversation list and that choice live in localStorage, together with your theme preference — functional only, with no tracking, which is why cookie-banner rules do not apply. Before you agree, nothing but the theme preference is stored. You can erase them yourself at any time, and change the choice from the conversation-history drawer.",
  },
} as const satisfies { keys: readonly string[]; setsCookies: boolean; body: Localized };
