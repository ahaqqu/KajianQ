import type { ReactNode } from "react";
import { t, useLocale, useLocaleSetter } from "../lib/i18n";
import { useTheme } from "../lib/theme";
import { LogoTile } from "./Logo";

/**
 * The app header (the reference design's): logo tile + serif-italic wordmark
 * over a mono uppercase letter-spaced tagline; the right side carries the
 * circular theme toggle and the language select, plus any route action (the
 * chat adds its "new conversation" pill). The wordmark is the product name —
 * always KajianQ.
 */
export function AppHeader({ actions }: { actions?: ReactNode }) {
  const locale = useLocale();
  const setLocale = useLocaleSetter();
  const { theme, toggle } = useTheme();

  return (
    <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-4">
      <LogoTile size="md" />
      <div className="min-w-0">
        <p className="font-serif text-[22px] font-semibold italic leading-tight">
          {t(locale, "appTitle")}
        </p>
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          {t(locale, "tagline")}
        </p>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {actions}
        <button
          type="button"
          data-testid="theme-toggle"
          aria-label={t(locale, "themeToggle")}
          onClick={toggle}
          className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border text-foreground hover:bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {theme === "light" ? <MoonIcon /> : <SunIcon />}
        </button>
        <select
          className="rounded-full border border-border bg-transparent px-2 py-1.5 font-mono text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={locale}
          aria-label={t(locale, "localeLabel")}
          data-testid="locale-select"
          onChange={(e) => setLocale(e.target.value as "en" | "id")}
        >
          <option value="en">EN</option>
          <option value="id">ID</option>
        </select>
      </div>
    </div>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-4">
      <path
        d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-4">
      <circle cx="12" cy="12" r="4" />
      <path
        d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
