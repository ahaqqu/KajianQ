import { Link } from "@tanstack/react-router";
import { forgetChatState, persistChatState, setConsent, useConsent } from "../../lib/chat-store";
import { t, useLocale } from "../../lib/i18n";
import { MonoLabel } from "../ui";

/** The current answer, for the views that reflect it (the transcript's
 * "saved here / not saved" line). Re-exported from this module so the page gets
 * the card and the value in one import. */
export { useConsent as useChatConsent } from "../../lib/chat-store";

/**
 * The one-time question before the chat keeps anything in the browser
 * (ADR-0063). It renders only while the answer is unrecorded: choosing either
 * answer stores the choice, hides the card, and is changeable later from the
 * history drawer.
 *
 * "Keep my conversation here" writes the chat state already held in memory (the
 * token and session id of a conversation that may already be under way), and
 * "Don't keep anything" erases what an earlier visit stored. Neither answer
 * touches the server: the answer's retention is a fact of the service, not of
 * this choice.
 */
export function ConsentCard() {
  const locale = useLocale();
  const consent = useConsent();

  /** The card unmounts with the focus inside it, which would drop a keyboard
   * reader back to the top of the page; the composer is where they were going. */
  const answer = (choice: "store" | "session-only"): void => {
    setConsent(choice);
    if (choice === "store") persistChatState();
    else forgetChatState();
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-testid="composer"]')?.focus();
    });
  };

  if (consent !== null) return null;

  return (
    <section
      data-testid="consent-card"
      aria-labelledby="consent-title"
      className="mb-3 rounded-2xl border border-rule bg-card/95 p-4 shadow-sm sm:p-5"
    >
      <MonoLabel>
        <span id="consent-title">{t(locale, "consentEyebrow")}</span>
      </MonoLabel>
      <p className="mt-3 text-[13px] leading-6 text-foreground sm:text-sm">
        {t(locale, "consentLead")}
      </p>
      <p className="mt-2 text-[13px] leading-6 text-muted-foreground sm:text-sm">
        {t(locale, "consentBody")}{" "}
        <Link to="/privacy" className="font-medium text-foreground underline underline-offset-4">
          {t(locale, "privacyCta")}
        </Link>
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="consent-keep"
          onClick={() => answer("store")}
          className="inline-flex h-9 items-center justify-center rounded-full bg-primary px-4 text-xs font-medium text-primary-foreground hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t(locale, "consentKeep")}
        </button>
        <button
          type="button"
          data-testid="consent-decline"
          onClick={() => answer("session-only")}
          className="inline-flex h-9 items-center justify-center rounded-full border border-border px-4 text-xs font-medium text-foreground hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t(locale, "consentDontKeep")}
        </button>
      </div>
    </section>
  );
}
