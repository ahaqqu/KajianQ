import { t, type Locale } from "../../lib/i18n";
import { LogoTile } from "../ui";

/**
 * The empty transcript state: its own file because it is a transcript-level
 * concern, not message rendering. Centered logo tile, the serif-italic greeting
 * at the reference's 30px display size, the two-line subtitle, and three
 * suggestion rows — the chips carry their own max-width inside the wider
 * transcript column. Each chip sends its question: KajianQ's own starter
 * questions per locale.
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
    <div data-testid="chat-empty" className="flex flex-col items-center pt-16 pb-8 text-center">
      <LogoTile size="lg" />
      <h1
        data-testid="chat-greeting"
        className="mt-8 max-w-md font-serif text-[30px] leading-[1.2] font-semibold italic text-balance"
      >
        {t(locale, "greeting")}
      </h1>
      <p className="mt-4 max-w-md text-base leading-7 text-muted-foreground">
        {t(locale, "emptyLine1")}
        <br />
        {t(locale, "emptyLine2")}
      </p>
      <div className="mt-7 w-full max-w-[512px] space-y-3">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            data-testid="suggestion-chip"
            className="w-full rounded-3xl border border-border bg-card px-6 py-3.5 text-left text-[15px] text-card-foreground hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onSuggest(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
