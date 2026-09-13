import { useEffect, useState } from "react";
import { MACHINE_TRANSLATION_LABEL } from "../../lib/chat-render";
import { t, type Locale } from "../../lib/i18n";
import { MonoLabel } from "../ui";
import type { ChatCitation } from "@app/contracts";

/**
 * The passage sheet a citation chip opens (#11), restyled in the reference
 * language: serif mono-labeled sections, the Arabic original in Amiri (RTL),
 * the translation as a gold-bordered blockquote with the ADR-0006
 * machine-translation label, the grade badge, and the mono source line —
 * every field server-derived from the trace, none inferred.
 */
export function CitationSheet({
  citation,
  locale,
  onClose,
}: {
  citation: ChatCitation;
  locale: Locale;
  onClose: () => void;
}) {
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
          {citation.grade !== undefined && <GradeBadge grade={citation.grade} />}
        </div>
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
      </div>
    </div>
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
