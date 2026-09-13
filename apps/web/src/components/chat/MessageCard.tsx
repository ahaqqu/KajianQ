import type { ChatSessionMessage } from "@app/contracts";
import { renderAnswerSegments, splitAnswerBlocks } from "../../lib/chat-render";
import { t, useLocale, type Locale } from "../../lib/i18n";
import { CitationSheet, useCitationSheet } from "./CitationSheet";
import { LogoTile } from "../Logo";

/**
 * One transcript turn (#11) in the reference visual language: the assistant
 * turn is an avatar + serif-italic name over a warm card holding the answer
 * (citation chips resolved from the structured frame), the dhaif warning
 * card, and the ulama disclaimer footnote. The user turn is a right-aligned
 * muted bubble. A refused answer carries an empty citation list, so it
 * renders as a plain card with no citation affordances by data, not by a
 * client-side guess about refusals.
 */
export function MessageCard({ message }: { message: ChatSessionMessage }) {
  const locale: Locale = useLocale();
  const sheet = useCitationSheet();

  if (message.role === "user") {
    return (
      <article
        data-testid="message-user"
        className="ml-auto w-fit max-w-[85%] rounded-xl bg-card px-4 py-2.5"
      >
        <p className="whitespace-pre-wrap text-[15px] text-card-foreground">{message.content}</p>
      </article>
    );
  }

  const split = splitAnswerBlocks(message.content);
  const citations = message.citations?.citations ?? [];
  const segments = renderAnswerSegments(split.body, citations);
  // The card shows the answer's own warning line when the deterministic
  // rule appended it; the frame's dhaifWarning flag drives the card even
  // when the line is missing from the (rehydrated) text.
  const warning =
    split.warning ??
    (message.citations?.dhaifWarning === true ? t(locale, "dhaifWarningCard") : null);

  return (
    <article data-testid="message-assistant" className="max-w-[95%] space-y-2">
      <div className="flex items-center gap-3">
        <LogoTile size="sm" />
        <span className="font-serif text-lg font-semibold italic">{t(locale, "appTitle")}</span>
      </div>
      <div className="ml-10 space-y-3 rounded-2xl bg-card px-5 py-4">
        <div className="space-y-3 text-[15px] leading-7 text-card-foreground">
          {segments.map((segment, i) =>
            segment.kind === "text" ? (
              <p key={i} className="whitespace-pre-wrap">
                {segment.text}
              </p>
            ) : (
              <CitationChip
                key={i}
                label={segment.label}
                locale={locale}
                onOpen={() => {
                  const citation = citations.find((c) => c.label === segment.label);
                  if (citation) sheet.open(citation);
                }}
              />
            ),
          )}
        </div>
        {warning !== null && (
          <div
            data-testid="dhaif-warning"
            role="note"
            className="rounded-r-lg border-l-2 border-destructive bg-destructive/10 px-3 py-2"
          >
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-destructive">
              {t(locale, "warningLabel")}
            </p>
            <p className="mt-1 text-sm text-card-foreground">{warning}</p>
          </div>
        )}
        {split.disclaimer !== null && (
          <p
            data-testid="ulama-disclaimer"
            className="border-t border-rule pt-2 font-mono text-[11px] uppercase tracking-wide text-muted-foreground"
          >
            {split.disclaimer}
          </p>
        )}
      </div>
      {sheet.active !== null && (
        <CitationSheet citation={sheet.active} locale={locale} onClose={sheet.close} />
      )}
    </article>
  );
}

/**
 * The empty transcript state: centered logo tile, the serif-italic greeting,
 * the two-line subtitle, and three full-width suggestion chips (each sends
 * its question — KajianQ's own starter questions per locale).
 */
export function EmptyState({
  locale,
  onSuggest,
}: {
  locale: Locale;
  onSuggest: (text: string) => void;
}) {
  const suggestions = [
    t(locale, "suggestion1"),
    t(locale, "suggestion2"),
    t(locale, "suggestion3"),
  ];
  return (
    <div data-testid="chat-empty" className="flex flex-col items-center pt-14 pb-8 text-center">
      <LogoTile size="lg" />
      <h1 data-testid="chat-greeting" className="mt-8 font-serif text-3xl font-semibold italic">
        {t(locale, "greeting")}
      </h1>
      <p className="mt-4 text-sm text-muted-foreground">
        {t(locale, "emptyLine1")}
        <br />
        {t(locale, "emptyLine2")}
      </p>
      <div className="mt-6 w-full space-y-3">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            data-testid="suggestion-chip"
            className="w-full rounded-xl bg-card px-4 py-3 text-left text-sm text-card-foreground hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onSuggest(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function CitationChip({
  label,
  locale,
  onOpen,
}: {
  label: string;
  locale: Locale;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="citation-chip"
      aria-label={`${t(locale, "citationChipAria")} ${label}`}
      className="inline-flex items-center rounded-md border border-accent/30 bg-accent/10 px-1.5 py-0.5 align-baseline font-mono text-[11px] uppercase tracking-wide text-accent-foreground hover:bg-accent/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onOpen}
    >
      [{label}]
    </button>
  );
}
