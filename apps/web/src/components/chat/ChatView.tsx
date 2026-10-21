import { useEffect, useRef, useState } from "react";
import { formatMessage, formatNumber, t, type Locale } from "../../lib/i18n";
import { CHAT_MESSAGE_MAX_LENGTH, type ChatSessionMessage } from "@app/contracts";
import { AppHeader } from "../AppHeader";
import { Transcript, TranscriptMeta, type TranscriptError } from "./Transcript";

/**
 * The chat view in the reference visual language: the app header with the new-conversation
 * pill, the scrollable transcript (see Transcript), and the bottom-pinned composer band. The
 * staged loading state names the pipeline's real stages; the page owns data and transport.
 *
 * `prefill` seeds the composer DRAFT ONLY — never auto-sent — and only while the draft is
 * still untouched, so an edited draft is never clobbered; the page strips the param after
 * reading it and the composer stays local-only.
 *
 * The composer mirrors the chat contract's `CHAT_MESSAGE_MAX_LENGTH` so a reader cannot
 * build a message the API will refuse: the `maxLength` attribute bounds what the browser
 * lets through, and the change handler clamps the value itself (pair-aware, see
 * `clampDraft`), because the attribute does not constrain a programmatically set value.
 */

const STAGE_KEYS = ["stagedContext", "stagedReview", "stagedCompose"] as const;
const STAGE_INTERVAL_MS = 1400;

/**
 * Clamp a draft to the ceiling without splitting a surrogate pair. Both the browser's
 * `maxLength` truncation and this function's slice can stop between the halves of an emoji,
 * so the check runs on the RESULT: a trailing high surrogate (0xD800–0xDBFF) with no low half
 * after it is dropped whole rather than leaving half a character the API accepts and the store
 * keeps.
 */
export function clampDraft(text: string): string {
  const clamped =
    text.length > CHAT_MESSAGE_MAX_LENGTH ? text.slice(0, CHAT_MESSAGE_MAX_LENGTH) : text;
  const last = clamped.charCodeAt(clamped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clamped.slice(0, -1) : clamped;
}

export type ChatViewError = TranscriptError;

export function ChatView({
  locale,
  messages,
  persistedMessageIds,
  busy,
  loadingTranscript,
  transcriptTruncated,
  error,
  online,
  prefill,
  onSend,
  onNewSession,
}: {
  locale: Locale;
  messages: readonly ChatSessionMessage[];
  /** The message ids known to name a persisted row (the hook's view gate). */
  persistedMessageIds: ReadonlySet<string>;
  busy: boolean;
  loadingTranscript: boolean;
  transcriptTruncated: boolean;
  error: ChatViewError;
  online: boolean;
  /** The seed question from the route's `?q=` param, if any. */
  prefill?: string | undefined;
  onSend: (text: string) => void;
  onNewSession: () => void;
}) {
  const [draft, setDraft] = useState(prefill ?? "");
  const [stage, setStage] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // The last seed this composer has taken: a seed applies once, and only while the draft
  // is still untouched.
  const seededRef = useRef<string | undefined>(prefill);

  // Seed the composer from the route's pre-fill: the draft becomes the question, never a sent
  // turn, and the `seededRef` guard applies it only while the draft is still untouched.
  useEffect(() => {
    if (prefill === undefined || seededRef.current === prefill) return;
    setDraft((current) => (current === (seededRef.current ?? "") ? prefill : current));
    seededRef.current = prefill;
  }, [prefill]);

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

  const sendText = (text: string): boolean => {
    // `loadingTranscript` is part of the guard: a send inside the rehydration window would
    // append optimistic turns the resolving transcript cannot contain.
    if (text === "" || busy || loadingTranscript) return false;
    onSend(text);
    return true;
  };

  // The ceiling hint is derived from the draft, not tracked in state, so it cannot go stale:
  // the number is the contract's, formatted per locale and substituted by `{max}`.
  const atMessageLimit = draft.length >= CHAT_MESSAGE_MAX_LENGTH;
  const limitHint = formatMessage(locale, "composerLimit", {
    max: formatNumber(locale, CHAT_MESSAGE_MAX_LENGTH),
  });

  // Guard before clearing: a send rejected by the busy or rehydration guard must preserve
  // the draft — never clear a message the user cannot recover.
  const submit = (): void => {
    const text = draft.trim();
    if (text === "" || !sendText(text)) return;
    setDraft("");
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden" data-testid="chat-view">
      <header className="shrink-0 border-b border-dashed border-rule">
        <AppHeader
          actions={
            <button
              type="button"
              data-testid="new-session"
              className="shrink-0 whitespace-nowrap rounded-full border border-border bg-card px-2 py-2 text-sm font-medium text-card-foreground hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4"
              onClick={onNewSession}
            >
              {t(locale, "newSession")}
            </button>
          }
        />
      </header>

      <div
        ref={listRef}
        data-testid="message-list"
        className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4"
      >
        <Transcript
          locale={locale}
          messages={messages}
          persistedMessageIds={persistedMessageIds}
          busy={busy}
          loadingTranscript={loadingTranscript}
          transcriptTruncated={transcriptTruncated}
          online={online}
          error={error}
          stagedLabel={busy ? t(locale, STAGE_KEYS[stage]!) : null}
          onSuggest={sendText}
        />
      </div>

      <div className="shrink-0 border-t border-rule bg-background pb-[calc(env(safe-area-inset-bottom)+0.625rem)]">
        <div className="mx-auto w-full max-w-3xl px-4 pt-3">
          <form
            className="relative rounded-xl border border-input bg-card"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <textarea
              data-testid="composer"
              aria-label={t(locale, "composerPlaceholder")}
              aria-describedby={atMessageLimit ? "composer-limit" : undefined}
              maxLength={CHAT_MESSAGE_MAX_LENGTH}
              className="w-full resize-none bg-transparent px-4 pb-10 pt-3 text-[15px] text-card-foreground outline-none placeholder:text-muted-foreground"
              rows={2}
              value={draft}
              placeholder={t(locale, "composerPlaceholder")}
              onChange={(event) => setDraft(clampDraft(event.target.value))}
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
              aria-label={t(locale, "send")}
              disabled={busy || loadingTranscript || draft.trim() === ""}
              className="absolute right-2.5 bottom-2.5 flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <EnterIcon />
            </button>
          </form>
          {/* Always in the DOM so the live region announces the transition — a
              conditionally mounted role="status" often goes unannounced. */}
          <p
            id="composer-limit"
            data-testid="composer-limit"
            role="status"
            className="min-h-4 pt-1 text-xs text-muted-foreground"
          >
            {atMessageLimit ? limitHint : ""}
          </p>
          <TranscriptMeta locale={locale} />
        </div>
      </div>
    </div>
  );
}

function EnterIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-4">
      <path
        d="M20 5v6a3 3 0 0 1-3 3H5m0 0 4-4m-4 4 4 4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
