import type { ChatSessionMessage } from "@app/contracts";
import { t, type Locale } from "../../lib/i18n";
import { MonoLabel } from "../ui";
import { EmptyState } from "./EmptyState";
import { MessageCard } from "./MessageCard";

/** The transcript's error projection (the view's subset of ChatError). */
export type TranscriptError = "rate_limited" | "unavailable" | "generic" | "load" | null;

/**
 * The transcript body (#11): the mono CONVERSATION rule row, the offline and
 * error banners, then the turns — empty state when there is nothing yet, one
 * card per message — plus the honest staged waiting label while a turn is in
 * flight, the rehydration line, and the capped-transcript note. The caller
 * owns the scroll container; the stage clock ticks in the caller and arrives
 * as `stagedLabel`.
 */
export function Transcript({
  locale,
  messages,
  busy,
  loadingTranscript,
  transcriptTruncated,
  online,
  error,
  stagedLabel,
  onSuggest,
}: {
  locale: Locale;
  messages: readonly ChatSessionMessage[];
  busy: boolean;
  loadingTranscript: boolean;
  transcriptTruncated: boolean;
  online: boolean;
  error: TranscriptError;
  /** The staged waiting label while `busy` (the caller owns the stage clock). */
  stagedLabel: string | null;
  onSuggest: (text: string) => void;
}) {
  return (
    <>
      <div className="flex items-center gap-3 pb-2 pt-4">
        <MonoLabel className="text-[11px]">{t(locale, "conversationLabel")}</MonoLabel>
        <span className="h-px flex-1 bg-rule" />
        <span className="font-mono text-[11px] text-muted-foreground">
          {t(locale, "savedLocally")}
        </span>
      </div>

      {!online && (
        <p
          role="alert"
          data-testid="offline-banner"
          className="mb-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-accent-foreground dark:text-accent"
        >
          {t(locale, "offlineBanner")}
        </p>
      )}
      {error !== null && (
        <p
          role="alert"
          data-testid="chat-error"
          className="mb-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error === "load" ? t(locale, "loadError") : errorCopy(locale, error)}
        </p>
      )}

      <div className="space-y-4 pb-4">
        {transcriptTruncated && !busy && (
          <MonoLabel data-testid="transcript-truncated" className="text-[11px]">
            {t(locale, "transcriptTruncated")}
          </MonoLabel>
        )}
        {messages.length === 0 && !loadingTranscript && !busy && (
          <EmptyState locale={locale} onSuggest={onSuggest} />
        )}
        {messages.map((message) => (
          <MessageCard key={message.id} message={message} />
        ))}
        {stagedLabel !== null && (
          <MonoLabel data-testid="staged-loading" aria-live="polite" className="text-[11px]">
            {stagedLabel}
          </MonoLabel>
        )}
        {loadingTranscript && <MonoLabel className="text-[11px]">{t(locale, "loading")}</MonoLabel>}
      </div>
    </>
  );
}

/**
 * The transcript's meta line — the reference's mono uppercase footer under
 * the composer band. It is the conversation's footnote (one conversation,
 * sourced answers, stored locally), so it lives with the transcript's
 * chrome rather than the composer's form.
 */
export function TranscriptMeta({ locale }: { locale: Locale }) {
  return <MonoLabel className="mt-2">{t(locale, "footerMeta")}</MonoLabel>;
}

function errorCopy(locale: Locale, error: Exclude<TranscriptError, "load" | null>): string {
  if (error === "rate_limited") return t(locale, "errorRateLimited");
  if (error === "unavailable") return t(locale, "errorUnavailable");
  return t(locale, "errorGeneric");
}
