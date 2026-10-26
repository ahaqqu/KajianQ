import { useEffect, useRef, useState, type Ref } from "react";
import { t, type Locale, useLocale, useLocaleSetter } from "../lib/i18n";
import { useTheme } from "../lib/theme";
import {
  BurgerIcon,
  CloseIcon,
  HistoryIcon,
  MoonIcon,
  NewChatIcon,
  SunIcon,
  TranslateIcon,
} from "./icons";

/**
 * The header's controls, split out of `AppHeader` (which owns the brand, the
 * nav and the drawer) so both files stay inside the agentic-limits caps. The
 * locale menu owns its own popover state; the rest are stateless buttons whose
 * visible round treatment is shared through `CONTROL`.
 */

const CONTROL =
  "flex size-9 shrink-0 items-center justify-center rounded-full border border-border text-foreground hover:bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ThemeToggle() {
  const locale = useLocale();
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      data-testid="theme-toggle"
      aria-label={t(locale, "themeToggle")}
      onClick={toggle}
      className={CONTROL}
    >
      {theme === "light" ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}

/**
 * The language control: a round pill showing the translation mark and the
 * active locale code, opening a two-item menu. A native `<select>` cannot carry
 * the reference's compact pill, so the menu is owned here with the disclosure
 * contract the tests pin: aria-haspopup/expanded, Escape closes and returns
 * focus, outside click and focus-out close.
 */
export function LocaleMenu() {
  const locale = useLocale();
  const setLocale = useLocaleSetter();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!root?.contains(event.target as Node)) setOpen(false);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!root?.contains(event.relatedTarget as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    root?.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      root?.removeEventListener("focusout", onFocusOut);
    };
  }, [open]);

  // Opening the menu moves focus to the checked option, so the keyboard lands
  // on the current choice instead of the toggle that opened it.
  useEffect(() => {
    if (!open) return;
    rootRef.current
      ?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
      ?.focus();
  }, [open]);

  const choose = (next: Locale) => {
    setLocale(next);
    setOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        ref={toggleRef}
        data-testid="locale-toggle"
        aria-label={`${t(locale, "localeLabel")}, ${locale.toUpperCase()}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="locale-menu"
        onClick={() => setOpen((value) => !value)}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 font-mono text-[11px] font-medium tracking-wide text-foreground hover:bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <TranslateIcon className="size-3.5" />
        {locale.toUpperCase()}
      </button>
      {open && (
        <ul
          id="locale-menu"
          role="menu"
          data-testid="locale-menu"
          aria-label={t(locale, "localeLabel")}
          className="absolute top-full right-0 z-50 mt-2 w-44 rounded-xl border border-border bg-popover p-1 shadow-lg"
          onKeyDown={(event) => {
            const items = Array.from(
              rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [],
            );
            const at = items.indexOf(document.activeElement as HTMLElement);
            const move = (index: number) => items[(index + items.length) % items.length]?.focus();
            if (event.key === "ArrowDown") move(at + 1);
            else if (event.key === "ArrowUp") move(at - 1);
            else if (event.key === "Home") move(0);
            else if (event.key === "End") move(items.length - 1);
            else return;
            event.preventDefault();
          }}
        >
          {(
            [
              ["en", "English"],
              ["id", "Bahasa Indonesia"],
            ] as const
          ).map(([value, label]) => (
            <li key={value}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={locale === value}
                data-testid={`locale-option-${value}`}
                onClick={() => choose(value)}
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {label}
                {locale === value && <span aria-hidden="true">·</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The chat's header pill: the new-conversation action, sm+ only. */
export function NewSessionButton({ onClick }: { onClick: () => void }) {
  const locale = useLocale();
  return (
    <button
      type="button"
      data-testid="new-session"
      onClick={onClick}
      className="hidden h-9 shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3 text-xs font-medium text-card-foreground hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:inline-flex"
    >
      <NewChatIcon className="size-4" />
      {t(locale, "newSession")}
    </button>
  );
}

/** The history trigger: a round control beside the new-conversation pill, on
 * the same breakpoints (the nav drawer carries it on phones). */
export function HistoryButton({
  onClick,
  buttonRef,
}: {
  onClick: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const locale = useLocale();
  return (
    <button
      type="button"
      ref={buttonRef}
      data-testid="history-toggle"
      aria-label={t(locale, "historyOpen")}
      aria-haspopup="dialog"
      onClick={onClick}
      className={`${CONTROL} hidden sm:flex`}
    >
      <HistoryIcon />
    </button>
  );
}

/** The hamburger, below lg only; `AppHeader` owns the drawer it controls. */
export function MenuButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  const locale = useLocale();
  return (
    <button
      type="button"
      data-testid="nav-menu-toggle"
      aria-expanded={open}
      aria-controls="primary-nav-menu"
      aria-label={t(locale, open ? "navMenuClose" : "navMenuOpen")}
      onClick={onClick}
      // While the drawer is open this control sits under the modal backdrop and
      // the drawer carries its own close: fading it out removes the second X,
      // and `opacity` (not `visibility`) keeps it focusable so Escape can
      // return focus to it as it reappears.
      className={`${CONTROL} lg:hidden ${open ? "pointer-events-none opacity-0" : ""}`}
    >
      {open ? <CloseIcon /> : <BurgerIcon />}
    </button>
  );
}

/** The drawer's close affordance (the backdrop is a second, unlabelled one). */
export function CloseButton({ onClick }: { onClick: () => void }) {
  const locale = useLocale();
  return (
    <button
      type="button"
      aria-label={t(locale, "navMenuClose")}
      onClick={onClick}
      className={CONTROL}
    >
      <CloseIcon />
    </button>
  );
}

/** The history drawer is a header part; it lives in its own file for the line cap. */
export { HistoryDrawer } from "./HistoryDrawer";
