import type { Ref } from "react";
import type { ChatHistoryEntry } from "../lib/chat-store";
import { formatMessage, t, type Locale } from "../lib/i18n";
import { CloseIcon, DownloadIcon, HistoryIcon } from "./icons";

/**
 * The drawer's parts: the close control and one conversation row. They hold no
 * state — `useChatHistory` owns the requests — so the row renders what it is
 * told and the drawer composes them.
 */

/** The round icon button a row's secondary actions share. */
const ROW_ACTION =
  "mt-1 flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100";

/** The drawer's close control, first focus stop when it opens. */
export function HistoryCloseButton({
  locale,
  onClose,
  buttonRef,
}: {
  locale: Locale;
  onClose: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      ref={buttonRef}
      data-testid="history-close"
      aria-label={t(locale, "historyClose")}
      onClick={onClose}
      className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border text-foreground hover:bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <CloseIcon className="size-4" />
    </button>
  );
}

/**
 * One row of the conversation-history drawer: the conversation's first question,
 * the language it was started in, how long ago, and — while the server still
 * holds it — the open and download actions. The row owns no state; the drawer
 * owns the requests and the busy flags.
 */
export function HistoryEntryRow({
  entry,
  locale,
  busy,
  onOpen,
  onDownload,
  onRemove,
}: {
  entry: ChatHistoryEntry;
  locale: Locale;
  busy: boolean;
  onOpen: () => void;
  onDownload: () => void;
  onRemove: () => void;
}) {
  const expired = entry.expired === true;
  return (
    <li
      data-testid="history-entry"
      data-expired={expired ? "true" : "false"}
      className="group flex items-start gap-1 rounded-xl px-3 py-2 hover:bg-card"
    >
      <button
        type="button"
        disabled={expired || busy}
        onClick={onOpen}
        className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
      >
        <span className="flex items-center gap-2">
          <HistoryIcon className="size-3.5 shrink-0 text-accent" />
          <span className="min-w-0 truncate text-sm text-foreground">{entry.title}</span>
        </span>
        <span className="mt-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
          <span>{entry.locale.toUpperCase()}</span>
          <span aria-hidden="true">·</span>
          {relativeTime(entry.startedAt, locale)}
          {expired && (
            <span className="rounded-full border border-border px-1.5 py-0.5">
              {t(locale, "historyExpired")}
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        data-testid="history-download"
        aria-label={t(locale, "historyDownload")}
        disabled={busy}
        onClick={onDownload}
        className={ROW_ACTION}
      >
        <DownloadIcon className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={t(locale, "historyRemove")}
        onClick={onRemove}
        className={ROW_ACTION}
      >
        <CloseIcon className="size-3" />
      </button>
    </li>
  );
}

/** "just now" / "12 min ago" / "3 h ago" / "5 d ago", in the reader's locale. */
export function relativeTime(at: number, locale: Locale): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return t(locale, "historyJustNow");
  if (minutes < 60) return formatMessage(locale, "historyMinutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatMessage(locale, "historyHoursAgo", { count: hours });
  return formatMessage(locale, "historyDaysAgo", { count: Math.floor(hours / 24) });
}
