import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { type Locale, t, useLocale, useLocaleSetter } from "../lib/i18n";
import { useTheme } from "../lib/theme";
import { LogoTile, MonoLabel } from "./ui";

/**
 * The app header (the reference design's): logo tile + serif-italic wordmark
 * over a mono uppercase letter-spaced tagline; the primary nav (Chat,
 * Collection, About) inline on sm+ screens; and on the right the circular theme
 * toggle and the language select, plus any route action (the chat adds its "new
 * conversation" pill). The wordmark is the product name — always KajianQ.
 * Below sm the nav collapses into a burger button that toggles a disclosure
 * menu (aria-expanded + aria-controls, aria-label from i18n, keyboard
 * reachable, closed automatically when the route changes); the wordmark block
 * compresses (min-w-0, truncated tagline) so the controls keep the reference's
 * single line (thermo-review C3).
 */
export function AppHeader({ actions }: { actions?: ReactNode }) {
  const locale = useLocale();
  const setLocale = useLocaleSetter();
  const { theme, toggle } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  // A menu left open would cover the page its own link just opened, so close
  // it whenever the route changes.
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  return (
    <div className="relative mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-4 sm:gap-3">
      <LogoTile size="md" />
      <div className="min-w-0">
        <p className="truncate font-serif text-[22px] font-semibold italic leading-tight">
          {t(locale, "appTitle")}
        </p>
        <MonoLabel className="truncate">{t(locale, "tagline")}</MonoLabel>
      </div>

      <nav aria-label={t(locale, "navLabel")} className="ml-4 hidden sm:block">
        <NavLinks locale={locale} />
      </nav>

      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
        {actions}
        <button
          type="button"
          data-testid="nav-menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="primary-nav-menu"
          aria-label={t(locale, menuOpen ? "navMenuClose" : "navMenuOpen")}
          onClick={() => setMenuOpen((open) => !open)}
          className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border text-foreground hover:bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
        >
          {menuOpen ? <CloseIcon /> : <BurgerIcon />}
        </button>
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
          className="rounded-full border border-border bg-transparent px-1.5 py-1.5 font-mono text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-2"
          value={locale}
          aria-label={t(locale, "localeLabel")}
          data-testid="locale-select"
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          <option value="en">EN</option>
          <option value="id">ID</option>
        </select>
      </div>

      {menuOpen && (
        <nav
          id="primary-nav-menu"
          aria-label={t(locale, "navLabel")}
          data-testid="nav-menu"
          className="absolute top-full right-4 left-4 z-40 rounded-xl border border-border bg-card p-2 shadow-lg sm:hidden"
        >
          <NavLinks locale={locale} stacked />
        </nav>
      )}
    </div>
  );
}

/** The three destinations the header carries, inline (sm+) or stacked (burger). */
function NavLinks({ locale, stacked = false }: { locale: Locale; stacked?: boolean }) {
  const items = [
    { to: "/", key: "navChat" },
    { to: "/collection", key: "navCollection" },
    { to: "/about", key: "navAbout" },
  ] as const;
  return (
    <ul className={stacked ? "flex flex-col" : "flex items-center gap-1"}>
      {items.map(({ to, key }) => (
        <li key={to}>
          <Link
            to={to}
            // "/" prefixes every route: without exact matching the Chat link
            // would read active on /about and /collection.
            activeOptions={{ exact: to === "/" }}
            activeProps={{
              "aria-current": "page",
              className: "text-foreground",
            }}
            inactiveProps={{ className: "text-muted-foreground" }}
            className="block rounded-lg px-3 py-1.5 text-sm font-medium hover:bg-secondary hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t(locale, key)}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function BurgerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-4">
      <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-4">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
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
