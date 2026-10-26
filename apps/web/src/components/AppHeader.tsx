import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { t, useLocale, type Locale } from "../lib/i18n";
import { CloseButton, LocaleMenu, MenuButton, NewSessionButton, ThemeToggle } from "./header-parts";
import { LogoTile, MonoLabel, NavLinks } from "./ui";

/**
 * The app header, in the reference's full-bleed treatment: a sticky bar across
 * the viewport with a 1152px inner row, the brand at the left, the primary nav
 * centered on lg+ and the round controls at the right. Below lg the nav moves
 * into a left drawer and the tagline and the new-conversation pill step aside,
 * so the mobile row keeps the whole wordmark beside its controls instead of
 * truncating it to two characters.
 *
 * The drawer keeps the disclosure contract the tests pin: aria-expanded /
 * aria-controls on the toggle, Escape closes and returns focus, focus leaving
 * the toggle+drawer subtree closes it, and a route change closes it. The chat
 * passes `onNewSession`, which renders the pill on sm+ and a full-width action
 * inside the drawer — the one mobile path back to a fresh conversation.
 */
export function AppHeader({ onNewSession }: { onNewSession?: () => void } = {}) {
  const locale = useLocale();
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // A drawer left open would cover the page its own link just opened, so close
  // it whenever the route changes (the router state read is required for that
  // close-on-navigate behavior — this component cannot render outside a
  // router; tests go through `renderApp`/`wrapInRouter`).
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const root = rootRef.current;
    if (!root) return;
    const toggle = root.querySelector('[data-testid="nav-menu-toggle"]');
    const drawer = root.querySelector('[data-testid="nav-drawer"]');
    const inDisclosure = (node: Node | null) =>
      node !== null && (node === toggle || (drawer?.contains(node) ?? false));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        root.querySelector<HTMLButtonElement>('[data-testid="nav-menu-toggle"]')?.focus();
      }
    };
    const onFocusOut = (event: FocusEvent) => {
      if (inDisclosure(event.target as Node) && !inDisclosure(event.relatedTarget as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    root.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      root.removeEventListener("focusout", onFocusOut);
    };
  }, [menuOpen]);

  return (
    // The wrapper exists for the drawer: `backdrop-filter` on the header makes
    // it the containing block for fixed descendants, which would clip a
    // viewport-sized drawer to the header's height. The drawer is therefore a
    // sibling of the blurred bar, inside the ref the focus contract watches.
    <div ref={rootRef} className="sticky top-0 z-40">
      <header className="border-b border-dashed border-rule bg-background/95 backdrop-blur">
        <div className="relative mx-auto flex h-[72px] w-full max-w-6xl items-center gap-3 px-4 sm:px-8 lg:grid lg:grid-cols-[1fr_auto_1fr]">
          <Link
            to="/"
            className="flex min-w-0 shrink-0 items-center gap-3 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:justify-self-start"
          >
            <LogoTile size="md" />
            <span className="min-w-0">
              <span className="block truncate font-serif text-[22px] leading-none font-semibold italic">
                {t(locale, "appTitle")}
              </span>
              <MonoLabel className="mt-1 hidden text-[9px] leading-none tracking-[0.18em] sm:block">
                {t(locale, "tagline")}
              </MonoLabel>
            </span>
          </Link>

          <nav
            aria-label={t(locale, "navLabel")}
            className="hidden lg:block lg:justify-self-center"
          >
            <NavLinks locale={locale} />
          </nav>

          <div className="ml-auto flex items-center gap-2 lg:ml-0 lg:justify-self-end">
            {onNewSession !== undefined && <NewSessionButton onClick={onNewSession} />}
            <LocaleMenu />
            <ThemeToggle />
            <MenuButton open={menuOpen} onClick={() => setMenuOpen((open) => !open)} />
          </div>
        </div>
      </header>

      {menuOpen && (
        <MobileDrawer
          locale={locale}
          onClose={() => setMenuOpen(false)}
          onNewSession={onNewSession}
        />
      )}
    </div>
  );
}

/** The below-lg navigation drawer: brand, large serif nav, chat action, legal. */
function MobileDrawer({
  locale,
  onClose,
  onNewSession,
}: {
  locale: Locale;
  onClose: () => void;
  onNewSession?: (() => void) | undefined;
}) {
  return (
    <div className="fixed inset-0 z-50 lg:hidden" data-testid="nav-drawer">
      <button
        type="button"
        aria-label={t(locale, "navMenuClose")}
        className="absolute inset-0 bg-foreground/50"
        onClick={onClose}
      />
      <div className="relative flex h-full w-[min(88vw,22rem)] flex-col overflow-y-auto border-r border-border bg-background px-6 py-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <Link to="/" onClick={onClose} className="flex items-center gap-3">
            <LogoTile size="md" />
            <span className="font-serif text-[22px] leading-none font-semibold italic">
              {t(locale, "appTitle")}
            </span>
          </Link>
          <CloseButton onClick={onClose} />
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{t(locale, "tagline")}</p>

        <nav
          id="primary-nav-menu"
          data-testid="nav-menu"
          aria-label={t(locale, "navLabel")}
          className="mt-6"
        >
          <NavLinks locale={locale} variant="drawer" />
        </nav>

        {onNewSession !== undefined && (
          <button
            type="button"
            data-testid="drawer-new-session"
            onClick={() => {
              onNewSession();
              onClose();
            }}
            className="mt-6 flex h-10 items-center justify-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t(locale, "newSession")}
          </button>
        )}

        <div className="mt-auto space-y-2 pt-8">
          <MonoLabel>{t(locale, "footerLegalLabel")}</MonoLabel>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <Link to="/privacy" onClick={onClose} className="hover:text-foreground">
              {t(locale, "footerPrivacy")}
            </Link>
            <Link to="/terms" onClick={onClose} className="hover:text-foreground">
              {t(locale, "footerTerms")}
            </Link>
            <Link to="/faq" onClick={onClose} className="hover:text-foreground">
              {t(locale, "navFaq")}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
