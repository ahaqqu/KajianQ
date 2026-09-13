import type { ChatSessionMessage } from "@app/contracts";
import { renderAnswerSegments, splitAnswerBlocks } from "../../lib/chat-render";
import { formatWhen, t, useLocale, type Locale } from "../../lib/i18n";
import { CitationSheet, useCitationSheet } from "./CitationSheet";

/**
 * One transcript turn (#11): a tight card (SPECS §3.1 — no excessive
 * whitespace). Assistant answers split into body (with citation chips
 * resolved from the structured frame), the dhaif warning card, and the
 * ulama disclaimer footer. A refused answer carries an empty citation list,
 * so it renders as a plain card with no citation affordances by data, not
 * by a client-side guess about refusals.
 */
export function MessageCard({ message }: { message: ChatSessionMessage }) {
  const locale: Locale = useLocale();
  const sheet = useCitationSheet();

  if (message.role === "user") {
    return (
      <article
        data-testid="message-user"
        className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-sky-500/15 px-3 py-2"
      >
        <p className="whitespace-pre-wrap text-sm text-slate-100">{message.content}</p>
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
    <article data-testid="message-assistant" className="max-w-[95%] space-y-1">
      <div className="rounded-2xl rounded-bl-sm border border-slate-800 bg-slate-900/60 px-3 py-2">
        <div className="space-y-1.5 text-sm leading-relaxed text-slate-100">
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
            className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
          >
            {warning}
          </div>
        )}
        {split.disclaimer !== null && (
          <p
            data-testid="ulama-disclaimer"
            className="mt-2 border-t border-slate-800 pt-2 text-xs italic text-slate-400"
          >
            {split.disclaimer}
          </p>
        )}
      </div>
      <p className="px-1 text-[11px] text-slate-400">
        {formatWhen(locale, new Date(message.createdAt))}
      </p>
      {sheet.active !== null && (
        <CitationSheet citation={sheet.active} locale={locale} onClose={sheet.close} />
      )}
    </article>
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
      className="inline-flex items-center rounded-full bg-sky-500/15 px-2 py-0.5 align-baseline font-mono text-xs text-sky-300 hover:bg-sky-500/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      onClick={onOpen}
    >
      [{label}]
    </button>
  );
}
