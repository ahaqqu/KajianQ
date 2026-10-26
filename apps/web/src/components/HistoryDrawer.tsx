import { useEffect, useRef } from "react";
import { t, useLocale } from "../lib/i18n";
import { useChatHistory, type HistoryNotice } from "../lib/use-chat-history";
import { HistoryCloseButton, HistoryEntryRow } from "./HistoryDrawerParts";

/** The list's message for each reason, so the row keeps its place. */
const NOTICE_KEYS: Record<HistoryNotice, "historyExpiredHint" | "historyOpenFailed"> = {
  expired: "historyExpiredHint",
  failed: "historyOpenFailed",
};

/**
 * The conversation-history drawer: the conversations this browser has held,
 * newest first, each one reopenable. The list itself is local metadata
 * (`useChatHistory`), and the storage switch at the foot is where the reader
 * changes what the chat may keep (ADR-0063).
 */
export function HistoryDrawer({ onClose }: { onClose: () => void }) {
  const locale = useLocale();
  const history = useChatHistory(onClose);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-title"
      data-testid="history-drawer"
    >
      <button
        type="button"
        aria-label={t(locale, "historyClose")}
        className="absolute inset-0 bg-foreground/40"
        onClick={onClose}
      />
      <aside className="absolute inset-y-0 right-0 flex w-[min(92vw,26rem)] flex-col border-l border-border bg-background shadow-2xl">
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <h2
            id="history-title"
            className="font-serif text-[26px] leading-none font-semibold italic sm:text-[30px]"
          >
            {t(locale, "historyTitle")}
          </h2>
          <HistoryCloseButton locale={locale} onClose={onClose} buttonRef={closeRef} />
        </div>
        <p className="mt-3 px-6 text-sm leading-6 text-muted-foreground">
          {t(locale, "historyLead")}
        </p>
        <div className="mt-4 border-t border-rule" />

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {history.consent !== "store" && (
            <p
              data-testid="history-consent-off"
              className="mx-3 mb-2 rounded-lg border border-rule bg-card/60 px-3 py-2 text-xs leading-5 text-muted-foreground"
            >
              {t(locale, "consentOffNote")}
            </p>
          )}
          {history.notice !== null && (
            <p
              role="alert"
              data-testid="history-notice"
              className="mb-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-accent-foreground dark:text-accent"
            >
              {t(locale, NOTICE_KEYS[history.notice])}
            </p>
          )}
          {history.entries.length === 0 ? (
            <div
              data-testid="history-empty"
              className="px-6 py-10 text-center text-sm text-muted-foreground"
            >
              <p className="font-medium text-foreground">{t(locale, "historyEmpty")}</p>
              <p className="mt-1">{t(locale, "historyEmptyHint")}</p>
            </div>
          ) : (
            <ul className="space-y-0.5">
              {history.entries.map((entry) => (
                <HistoryEntryRow
                  key={entry.id}
                  entry={entry}
                  locale={locale}
                  busy={history.busy}
                  onOpen={() => void history.open(entry)}
                  onRemove={() => history.remove(entry.id)}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-rule px-6 py-4">
          <button
            type="button"
            data-testid={history.consent === "store" ? "consent-disable" : "consent-enable"}
            onClick={() => history.setKeep(history.consent !== "store")}
            className="mb-2 text-xs font-medium underline underline-offset-4 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t(locale, history.consent === "store" ? "consentDisable" : "consentEnable")}
          </button>
          {history.consent === "store" && (
            <p className="text-xs leading-5 text-muted-foreground">
              {t(locale, "historyLocalNote")}
            </p>
          )}
          {history.entries.length > 0 && (
            <button
              type="button"
              data-testid="history-clear"
              onClick={history.clear}
              className="mt-2 text-xs font-medium underline underline-offset-4 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t(locale, "historyClearAll")}
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}
