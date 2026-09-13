import { t, type Locale } from "../../lib/i18n";
import { LogoTile } from "../ui";

/**
 * The empty transcript state (thermo-review B2: its own file — a
 * transcript-level concern, not message rendering): centered logo tile, the
 * serif-italic greeting at the reference's measured 22px (thermo-review C1),
 * the two-line subtitle, and three suggestion chips constrained to the
 * reference's ~512px centered inset (thermo-review C2 — the chips carry
 * their own max-width inside the wider transcript column). Each chip sends
 * its question — KajianQ's own starter questions per locale.
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
      <h1 data-testid="chat-greeting" className="mt-8 font-serif text-[22px] font-semibold italic">
        {t(locale, "greeting")}
      </h1>
      <p className="mt-4 text-sm text-muted-foreground">
        {t(locale, "emptyLine1")}
        <br />
        {t(locale, "emptyLine2")}
      </p>
      <div className="mt-6 w-full max-w-[512px] space-y-3">
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
