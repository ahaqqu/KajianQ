import { useCallback, useEffect, useState } from "react";

/**
 * Light/dark theme (the reference design's toggle): `.dark` on <html>,
 * persisted in localStorage, default light. `initTheme` runs before the first
 * render (main.tsx) so a dark preference never flashes the light theme.
 */

/** Exported so the /about notice's storage card (`privacy-notice-storage.ts`)
 * names the key from here instead of duplicating the literal (thermo-review B1). */
export const THEME_KEY = "kajianq.theme";

export type Theme = "light" | "dark";

export function readStoredTheme(): Theme {
  try {
    return globalThis.localStorage?.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/** Synchronous first-paint theme application (no provider, no flash). */
export function initTheme(): void {
  applyTheme(readStoredTheme());
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  useEffect(() => {
    applyTheme(theme);
    try {
      globalThis.localStorage?.setItem(THEME_KEY, theme);
    } catch {
      // Private mode without storage: the choice just won't persist.
    }
  }, [theme]);
  const toggle = useCallback(
    () => setTheme((current) => (current === "light" ? "dark" : "light")),
    [],
  );
  return { theme, toggle };
}
