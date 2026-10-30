import { useEffect, useState, type ReactNode } from "react";
import { MACHINE_TRANSLATION_LABEL } from "../../lib/chat-render";
import { t, useLocale } from "../../lib/i18n";
import { MonoLabel } from "../ui";
import type { ChatChain, ChatCitation } from "@app/contracts";

/**
 * The passage sheet a citation chip opens, in the reference language: serif
 * mono-labeled sections, the Arabic original in Amiri (RTL), the translation
 * as a gold-bordered blockquote with the ADR-0006 machine-translation label,
 * the grade badge, and the mono source line — every field server-derived from
 * the trace, none inferred. The optional `children` slot is the sheet's
 * footer; MessageCard fills it with the trace-anchored flags anchored to this
 * sheet's label.
 */
export function CitationSheet({
  citation,
  onClose,
  children,
  renderChainFlag,
}: {
  citation: ChatCitation;
  onClose: () => void;
  children?: ReactNode;
  /** The footer affordance for one chain row, so a grade flag names its own row. */
  renderChainFlag?: (chain: ChatChain, index: number) => ReactNode;
}) {
  const locale = useLocale();
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-end"
      role="dialog"
      aria-modal="true"
      aria-label={citation.label}
    >
      <button
        type="button"
        aria-label={t(locale, "closeSheet")}
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div
        data-testid="citation-sheet"
        className="relative z-10 w-full rounded-t-2xl border-t border-border bg-card p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between gap-2">
          <span className="rounded-md border border-accent/30 bg-accent/10 px-2 py-1 font-mono text-[11px] uppercase tracking-wide text-accent-foreground dark:text-accent">
            {citation.label}
          </span>
          {citation.chainsUnread !== true &&
            (citation.chains === undefined || citation.chains.length === 0) &&
            citation.grade !== undefined && <GradeBadge grade={citation.grade} />}
        </div>
        {citation.chainsUnread === true && (
          <p
            data-testid="citation-chains-unread"
            className="mb-4 rounded-lg border border-rule px-3 py-2 text-sm text-muted-foreground"
          >
            {t(locale, "citationChainsUnread")}
          </p>
        )}
        {citation.chains !== undefined && citation.chains.length > 0 && (
          <ChainList chains={citation.chains} locale={locale} renderChainFlag={renderChainFlag} />
        )}
        <MonoLabel>{t(locale, "arabicOriginal")}</MonoLabel>
        <p
          dir="rtl"
          lang="ar"
          data-testid="citation-arabic"
          className="mt-1 mb-4 text-right font-arabic text-xl leading-loose text-card-foreground"
        >
          {citation.arabic}
        </p>
        {citation.translation !== undefined && (
          <>
            <MonoLabel>{t(locale, "translationLabel")}</MonoLabel>
            <blockquote className="mt-1 mb-3 border-l-2 border-accent pl-3">
              <p
                data-testid="citation-translation"
                className="font-serif text-base italic text-card-foreground"
              >
                {citation.translation}
              </p>
              {citation.machineTranslated && (
                <MonoLabel className="mt-1" data-testid="citation-mt-label">
                  ({MACHINE_TRANSLATION_LABEL})
                </MonoLabel>
              )}
            </blockquote>
          </>
        )}
        {citation.source !== undefined && (
          <MonoLabel className="mt-4">
            {t(locale, "sourceLabel")}:{" "}
            <span data-testid="citation-source" className="normal-case tracking-normal">
              {citation.source}
            </span>
          </MonoLabel>
        )}
        {children !== undefined && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-rule pt-3">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The passage's transmission rows, one block per stored row in the record's own
 * order: its grade badge (an ungraded row says so rather than borrowing another
 * row's grade), the grader the trace attributed it to, the ordered sanad in
 * Arabic, and — when the parent supplies one — that row's own flag affordance.
 * Every row renders — the sheet never picks the strongest — so a passage whose
 * chains disagree reads as conflicting evidence rather than one verdict.
 */
function ChainList({
  chains,
  locale,
  renderChainFlag,
}: {
  chains: NonNullable<ChatCitation["chains"]>;
  locale: ReturnType<typeof useLocale>;
  renderChainFlag?: ((chain: ChatChain, index: number) => ReactNode) | undefined;
}) {
  return (
    <>
      <MonoLabel>{t(locale, "citationSanadLabel")}</MonoLabel>
      <ul data-testid="citation-chains" className="mb-4 mt-1 space-y-2">
        {chains.map((chain, index) => (
          <li
            data-testid="citation-chain"
            key={`${chain.grade ?? "ungraded"}-${index}`}
            className="rounded-lg border border-rule px-3 py-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              {chain.grade !== undefined ? (
                <GradeBadge grade={chain.grade} />
              ) : (
                <span
                  data-testid="citation-chain-ungraded"
                  className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground"
                >
                  {t(locale, "citationChainUngraded")}
                </span>
              )}
              {chain.grader !== undefined && (
                <span data-testid="citation-grader" className="text-xs text-muted-foreground">
                  {t(locale, "citationGraderLabel")}: {chain.grader}
                </span>
              )}
              {renderChainFlag?.(chain, index)}
            </div>
            <p
              dir="rtl"
              lang="ar"
              data-testid="citation-sanad"
              className="mt-1 text-right font-arabic text-lg leading-loose text-card-foreground"
            >
              {chain.narrators.map((narrator) => narrator.nameAr ?? narrator.id).join(" < ")}
            </p>
            {chain.moreMayExist === true && (
              <p
                data-testid="citation-chain-truncated"
                className="mt-1 text-xs text-muted-foreground"
              >
                {t(locale, "citationChainTruncated")}
              </p>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Grade badge: the weak grade must be visually unmissable (spec §2.2). */
export function GradeBadge({ grade }: { grade: string }) {
  const weak = grade.toLowerCase() === "dhaif";
  const tone = weak
    ? "bg-destructive/15 text-destructive"
    : "bg-primary/15 text-primary dark:text-foreground";
  return (
    <span
      data-testid="grade-badge"
      className={`rounded-full px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide ${tone}`}
    >
      {grade}
    </span>
  );
}

/** Small hook backstop so the sheet state never leaks across messages. */
export function useCitationSheet(): {
  active: ChatCitation | null;
  open: (citation: ChatCitation) => void;
  close: () => void;
} {
  const [active, setActive] = useState<ChatCitation | null>(null);
  return {
    active,
    open: (citation) => setActive(citation),
    close: () => setActive(null),
  };
}
