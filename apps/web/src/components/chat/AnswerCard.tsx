import type { ChatSessionMessage } from "@app/contracts";
import { renderAnswerSegments, splitAnswerBlocks } from "../../lib/chat-render";
import { t, useLocale, type Locale } from "../../lib/i18n";
import { LogoTile, MonoLabel } from "../ui";
import { CitationSheet, useCitationSheet } from "./CitationSheet";

/**
 * The assistant turn's answer card (#11) in the reference visual language:
 * an avatar + serif-italic name over a warm card holding the answer
 * (citation chips resolved from the structured frame), the dhaif warning
 * card, and the ulama disclaimer footnote. A refused answer carries an empty
 * citation list, so it renders as a plain card with no citation affordances
 * by data, not by a client-side guess about refusals.
 */
export function AnswerCard({ message }: { message: ChatSessionMessage }) {
  const locale: Locale = useLocale();
  const sheet = useCitationSheet();

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
            <MonoLabel className="text-destructive">{t(locale, "warningLabel")}</MonoLabel>
            <p className="mt-1 text-sm text-card-foreground">{warning}</p>
          </div>
        )}
        {split.disclaimer !== null && (
          <MonoLabel
            data-testid="ulama-disclaimer"
            className="border-t border-rule pt-2 text-[11px]"
          >
            {split.disclaimer}
          </MonoLabel>
        )}
      </div>
      {sheet.active !== null && (
        <CitationSheet citation={sheet.active} locale={locale} onClose={sheet.close} />
      )}
    </article>
  );
}

/**
 * The citation chip: small mono uppercase chip inside the answer card; dark
 * mode takes the gold itself for the label (thermo-review A2 — the dark
 * theme's --accent-foreground is near-black, tuned for solid-gold surfaces,
 * and is unreadable on the chip's faint tint).
 */
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
      className="inline-flex items-center rounded-md border border-accent/30 bg-accent/10 px-1.5 py-0.5 align-baseline font-mono text-[11px] uppercase tracking-wide text-accent-foreground dark:text-accent hover:bg-accent/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onOpen}
    >
      [{label}]
    </button>
  );
}
