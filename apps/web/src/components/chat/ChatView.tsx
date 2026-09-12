import { useEffect, useRef, useState } from "react";
import { t, type Locale } from "../../lib/i18n";
import type { ChatSessionMessage } from "@app/contracts";
import { MessageCard } from "./MessageCard";

/**
 * The chat view (#11): tight message list, staged honest loading state
 * ("Mengambil konteks…" → "Memeriksa sitasi…" → "Menyusun jawaban…" — the
 * machinery the pipeline actually runs), composer pinned at the bottom,
 * edge-state banners. Presentational: the page owns data and transport.
 */

const STAGE_KEYS = ["stagedContext", "stagedReview", "stagedCompose"] as const;
const STAGE_INTERVAL_MS = 1400;

export type ChatViewError = "rate_limited" | "unavailable" | "generic" | "load" | null;

export function ChatView({
  locale,
  messages,
  busy,
  loadingTranscript,
  transcriptTruncated,
  error,
  online,
  onSend,
  onNewSession,
}: {
  locale: Locale;
  messages: readonly ChatSessionMessage[];
  busy: boolean;
  loadingTranscript: boolean;
  transcriptTruncated: boolean;
  error: ChatViewError;
  online: boolean;
  onSend: (text: string) => void;
  onNewSession: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [stage, setStage] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // The staged waiting state cycles through the pipeline's real stages while
  // the turn is in flight; it never shows when the answer is already streaming.
  useEffect(() => {
    if (!busy) {
      setStage(0);
      return;
    }
    const timer = window.setInterval(
      () => setStage((s) => Math.min(s + 1, STAGE_KEYS.length - 1)),
      STAGE_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  const submit = (): void => {
    const text = draft.trim();
    // `loadingTranscript` is part of the guard (thermo-review A1): a send
    // inside the rehydration window would append optimistic turns that the
    // resolving transcript cannot contain. The hook's effect also discards
    // any mid-turn transcript result; this keeps the race unreachable from
    // the UI in the first place.
    if (text === "" || busy || loadingTranscript) return;
    setDraft("");
    onSend(text);
  };

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col" data-testid="chat-view">
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          data-testid="new-session"
          className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          onClick={onNewSession}
        >
          {t(locale, "newSession")}
        </button>
      </div>

      {!online && (
        <p
          role="alert"
          data-testid="offline-banner"
          className="mb-2 rounded-lg bg-slate-800 px-3 py-2 text-xs text-amber-300"
        >
          {t(locale, "offlineBanner")}
        </p>
      )}
      {error !== null && (
        <p
          role="alert"
          data-testid="chat-error"
          className="mb-2 rounded-lg bg-rose-500/15 px-3 py-2 text-xs text-rose-200"
        >
          {error === "load" ? t(locale, "loadError") : errorCopy(locale, error)}
        </p>
      )}

      <div
        ref={listRef}
        className="flex-1 space-y-3 overflow-y-auto pr-1"
        data-testid="message-list"
      >
        {transcriptTruncated && !busy && (
          <p data-testid="transcript-truncated" className="px-1 pb-1 text-xs text-slate-500">
            {t(locale, "transcriptTruncated")}
          </p>
        )}
        {messages.length === 0 && !loadingTranscript && !busy && <EmptyState locale={locale} />}
        {messages.map((message) => (
          <MessageCard key={message.id} message={message} />
        ))}
        {busy && (
          <p
            data-testid="staged-loading"
            aria-live="polite"
            className="px-1 text-xs text-slate-400"
          >
            {t(locale, STAGE_KEYS[stage]!)}
          </p>
        )}
        {loadingTranscript && <p className="px-1 text-xs text-slate-400">{t(locale, "loading")}</p>}
      </div>

      <form
        className="mt-2 flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          data-testid="composer"
          aria-label={t(locale, "composerPlaceholder")}
          className="flex-1 resize-none rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-sky-500"
          rows={2}
          value={draft}
          placeholder={t(locale, "composerPlaceholder")}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="submit"
          data-testid="send"
          disabled={busy || loadingTranscript || draft.trim() === ""}
          className="rounded-xl bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-50"
        >
          {t(locale, "send")}
        </button>
      </form>
    </div>
  );
}

function errorCopy(locale: Locale, error: Exclude<ChatViewError, "load" | null>): string {
  if (error === "rate_limited") return t(locale, "errorRateLimited");
  if (error === "unavailable") return t(locale, "errorUnavailable");
  return t(locale, "errorGeneric");
}

function EmptyState({ locale }: { locale: Locale }) {
  return (
    <div data-testid="chat-empty" className="mt-10 space-y-1 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">{t(locale, "homeTitle")}</h1>
      <p className="text-sm font-medium text-slate-300">{t(locale, "chatEmptyTitle")}</p>
      <p className="text-xs text-slate-400">{t(locale, "chatEmptyHint")}</p>
    </div>
  );
}
