import { useEffect, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  OPEN_SESSION_EVENT,
  clearChatHistory,
  forgetChatState,
  loadChatHistory,
  markChatSessionExpired,
  persistChatState,
  rehydrateSession,
  removeChatHistoryEntry,
  saveStoredSessionId,
  setConsent,
  useConsent,
  type ChatHistoryEntry,
} from "../lib/chat-store";
import { formatMessage, t, useLocale, type Locale } from "../lib/i18n";
import { CloseIcon, HistoryIcon } from "./icons";

/**
 * The conversation-history drawer: the conversations this browser has held,
 * newest first, each one reopenable. The list is local metadata (see
 * `loadChatHistory`), so the drawer owns opening and pruning it.
 *
 * Opening rehydrates through the transcript endpoint FIRST, then hands the
 * fetched transcript to the mounted chat through `OPEN_SESSION_EVENT` — the
 * drawer is rendered by the header on every route, the chat hook only on the
 * chat route. That order is what lets an expired conversation be answered
 * where the reader is looking (the row turns "Expired"), instead of closing the
 * drawer and leaving them on a blank chat or a generic error card.
 */
export function HistoryDrawer({ onClose }: { onClose: () => void }) {
  const locale = useLocale();
  const consent = useConsent();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [entries, setEntries] = useState<readonly ChatHistoryEntry[]>(() => loadChatHistory());
  const [opening, setOpening] = useState<string | null>(null);
  const [notice, setNotice] = useState<"expired" | "failed" | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const refresh = (): void => setEntries(loadChatHistory());

  const openEntry = async (entry: ChatHistoryEntry): Promise<void> => {
    if (opening !== null) return;
    setOpening(entry.id);
    setNotice(null);
    try {
      const transcript = await rehydrateSession(entry.id);
      if (transcript === null) {
        markChatSessionExpired(entry.id);
        refresh();
        setNotice("expired");
        return;
      }
      saveStoredSessionId(entry.id);
      window.dispatchEvent(
        new CustomEvent(OPEN_SESSION_EVENT, { detail: { id: entry.id, transcript } }),
      );
      // No chat mounted (a static page): the stored id is what the chat
      // rehydrates from once the navigation lands.
      if (pathname !== "/") void navigate({ to: "/" });
      onClose();
    } catch {
      setNotice("failed");
    } finally {
      setOpening(null);
    }
  };

  const remove = (id: string): void => {
    removeChatHistoryEntry(id);
    refresh();
  };

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
          <button
            type="button"
            ref={closeRef}
            data-testid="history-close"
            aria-label={t(locale, "historyClose")}
            onClick={onClose}
            className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border text-foreground hover:bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CloseIcon className="size-4" />
          </button>
        </div>
        <p className="mt-3 px-6 text-sm leading-6 text-muted-foreground">
          {t(locale, "historyLead")}
        </p>
        <div className="mt-4 border-t border-rule" />

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {consent !== "store" && (
            <p
              data-testid="history-consent-off"
              className="mx-3 mb-2 rounded-lg border border-rule bg-card/60 px-3 py-2 text-xs leading-5 text-muted-foreground"
            >
              {t(locale, "consentOffNote")}
            </p>
          )}
          {notice !== null && (
            <p
              role="alert"
              data-testid="history-notice"
              className="mb-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-accent-foreground dark:text-accent"
            >
              {t(locale, notice === "expired" ? "historyExpiredHint" : "historyOpenFailed")}
            </p>
          )}
          {entries.length === 0 ? (
            <div
              data-testid="history-empty"
              className="px-6 py-10 text-center text-sm text-muted-foreground"
            >
              <p className="font-medium text-foreground">{t(locale, "historyEmpty")}</p>
              <p className="mt-1">{t(locale, "historyEmptyHint")}</p>
            </div>
          ) : (
            <ul className="space-y-0.5">
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  data-testid="history-entry"
                  data-expired={entry.expired === true ? "true" : "false"}
                  className="group flex items-start gap-1 rounded-xl px-3 py-2 hover:bg-card"
                >
                  <button
                    type="button"
                    disabled={entry.expired === true || opening !== null}
                    onClick={() => void openEntry(entry)}
                    className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
                  >
                    <span className="flex items-center gap-2">
                      <HistoryIcon className="size-3.5 shrink-0 text-accent" />
                      <span className="min-w-0 truncate text-sm text-foreground">
                        {entry.title}
                      </span>
                    </span>
                    <span className="mt-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                      <span>{entry.locale.toUpperCase()}</span>
                      <span aria-hidden="true">·</span>
                      {relativeTime(entry.startedAt, locale)}
                      {entry.expired === true && (
                        <span className="rounded-full border border-border px-1.5 py-0.5">
                          {t(locale, "historyExpired")}
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={t(locale, "historyRemove")}
                    onClick={() => remove(entry.id)}
                    className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                  >
                    <CloseIcon className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-rule px-6 py-4">
          <button
            type="button"
            data-testid={consent === "store" ? "consent-disable" : "consent-enable"}
            onClick={() => {
              if (consent === "store") {
                setConsent("session-only");
                forgetChatState();
              } else {
                setConsent("store");
                persistChatState();
              }
              refresh();
            }}
            className="mb-2 text-xs font-medium underline underline-offset-4 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t(locale, consent === "store" ? "consentDisable" : "consentEnable")}
          </button>
          <p className="text-xs leading-5 text-muted-foreground">{t(locale, "historyLocalNote")}</p>
          {entries.length > 0 && (
            <button
              type="button"
              data-testid="history-clear"
              onClick={() => {
                clearChatHistory();
                refresh();
              }}
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

/** "just now" / "12 min ago" / "3 h ago" / "5 d ago", in the reader's locale. */
function relativeTime(at: number, locale: Locale): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return t(locale, "historyJustNow");
  if (minutes < 60) return formatMessage(locale, "historyMinutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatMessage(locale, "historyHoursAgo", { count: hours });
  return formatMessage(locale, "historyDaysAgo", { count: Math.floor(hours / 24) });
}
