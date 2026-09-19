import { useEffect, useRef, useState } from "react";
import { t, type Locale } from "../../lib/i18n";
import type { ChatSessionMessage } from "@app/contracts";
import { AppHeader } from "../AppHeader";
import { Transcript, TranscriptMeta, type TranscriptError } from "./Transcript";

/**
 * The chat view (#11) in the reference visual language: the app header with
 * the new-conversation pill, the scrollable transcript (see Transcript), and
 * the bottom-pinned composer band with the circular submit button. Staged
 * honest loading state ("Mengambil konteks…" → "Memeriksa sitasi…" →
 * "Menyusun jawaban…" — the machinery the pipeline actually runs).
 * Presentational: the page owns data and transport.
 *
 * Pre-fill (#175): `prefill` is the seed question the chat route read from the
 * URL's `q` param. It seeds the composer DRAFT ONLY — never auto-sent — and
 * only while the draft is still at its initial, untouched state, so a draft
 * the reader already edited is never clobbered. The page consumes (strips) the
 * param after reading it; the seed arrives here as a plain prop and the
 * composer stays local-only: nothing about the pre-fill touches the chat
 * session/server contract (ADR-0040).
 */

const STAGE_KEYS = ["stagedContext", "stagedReview", "stagedCompose"] as const;
const STAGE_INTERVAL_MS = 1400;

export type ChatViewError = TranscriptError;

export function ChatView({
  locale,
  messages,
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
  busy: boolean;
  loadingTranscript: boolean;
  transcriptTruncated: boolean;
  error: ChatViewError;
  online: boolean;
  /** The seed question from the route's `?q=` param, if any (see above). */
  prefill?: string | undefined;
  onSend: (text: string) => void;
  onNewSession: () => void;
}) {
  const [draft, setDraft] = useState(prefill ?? "");
  const [stage, setStage] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // The last seed this composer has taken. A seed is applied only once, and
  // only while it equals the draft's initial state — i.e. while the reader has
  // not touched the composer (see the seeding effect).
  const seededRef = useRef<string | undefined>(prefill);

  // Seed the composer from the route's pre-fill (#175): the draft becomes the
  // question, never a sent turn. The clobber guard is the `seededRef`
  // comparison: the effect re-runs when the seed arrives (client-side
  // navigation) but applies it only while the draft is still the untouched
  // initial value, so a draft the reader has already edited is never
  // overwritten. A seed already taken is not re-applied; an absent seed leaves
  // the composer alone.
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
    // `loadingTranscript` is part of the guard (thermo-review A1): a send
    // inside the rehydration window would append optimistic turns that the
    // resolving transcript cannot contain.
    if (text === "" || busy || loadingTranscript) return false;
    onSend(text);
    return true;
  };

  // Guard before clearing (thermo-review A1): a send rejected by the busy or
  // rehydration guard must preserve the draft, exactly as before the
  // submit/sendText split — never clear a message the user cannot recover.
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
              className="w-full resize-none bg-transparent px-4 pb-10 pt-3 text-[15px] text-card-foreground outline-none placeholder:text-muted-foreground"
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
              aria-label={t(locale, "send")}
              disabled={busy || loadingTranscript || draft.trim() === ""}
              className="absolute right-2.5 bottom-2.5 flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <EnterIcon />
            </button>
          </form>
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
