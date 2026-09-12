import { useEffect, useState } from "react";
import { MACHINE_TRANSLATION_LABEL } from "../../lib/chat-render";
import { t, type Locale } from "../../lib/i18n";
import type { ChatCitation } from "@app/contracts";

/**
 * The passage sheet a citation chip opens (#11): Arabic original (RTL),
 * translation with the ADR-0006 machine-translation label when the payload
 * says the translation is machine-made, the grade badge, and the source
 * reference — every field server-derived from the trace, none inferred.
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
    <div className="fixed inset-0 z-40 flex items-end" role="dialog" aria-modal="true" aria-label={citation.label}>
      <button
        type="button"
        aria-label={t(locale, "closeSheet")}
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div
        data-testid="citation-sheet"
        className="relative z-10 w-full rounded-t-2xl border border-slate-700 bg-slate-900 p-4 shadow-2xl"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="rounded-full bg-sky-500/15 px-2 py-0.5 font-mono text-xs text-sky-300">
            {citation.label}
          </span>
          {citation.grade !== undefined && (
            <GradeBadge grade={citation.grade} />
          )}
        </div>
        <p className="mb-1 text-xs uppercase tracking-wide text-slate-400">
          {t(locale, "arabicOriginal")}
        </p>
        <p dir="rtl" lang="ar" data-testid="citation-arabic" className="mb-3 text-right font-serif text-lg leading-loose text-slate-100">
          {citation.arabic}
        </p>
        {citation.translation !== undefined && (
          <>
            <p className="mb-1 text-xs uppercase tracking-wide text-slate-400">
              {t(locale, "translationLabel")}
            </p>
            <p data-testid="citation-translation" className="mb-1 text-sm text-slate-200">
              {citation.translation}
            </p>
            {citation.machineTranslated && (
              <p data-testid="citation-mt-label" className="mb-3 text-xs text-amber-300/90">
                ({MACHINE_TRANSLATION_LABEL})
              </p>
            )}
          </>
        )}
        {citation.source !== undefined && (
          <p className="mt-3 text-xs text-slate-400">
            {t(locale, "sourceLabel")}: <span data-testid="citation-source">{citation.source}</span>
          </p>
        )}
      </div>
    </div>
  );
}

/** Grade badge: the weak grade must be visually unmissable (spec §2.2). */
export function GradeBadge({ grade }: { grade: string }) {
  const weak = grade.toLowerCase() === "dhaif";
  const tone = weak
    ? "bg-rose-500/20 text-rose-300"
    : "bg-emerald-500/15 text-emerald-300";
  return (
    <span data-testid="grade-badge" className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
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
