import { Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { LocaleCtx, t, type Locale } from "../lib/i18n";
import { SwUpdatePrompt } from "../lib/sw-update";

/**
 * App shell: owns the selected locale and the top nav. The SW update prompt
 * renders inside the locale provider so its copy follows the language switch.
 * The foundation shell has a single home route; product routes arrive with
 * the chat UI in later milestones.
 */
export function Shell() {
  const [locale, setLocale] = useState<Locale>("en");

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <LocaleCtx.Provider value={locale}>
      <div className="mx-auto min-h-screen max-w-lg px-4 py-8">
        <nav className="mb-6 flex flex-wrap items-center gap-3 text-sm">
          <span className="font-semibold text-sky-400">
            {t(locale, "appTitle")}
          </span>
          <label className="ml-auto flex items-center gap-2 text-slate-300">
            <span>{t(locale, "localeLabel")}</span>
            <select
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1"
              value={locale}
              aria-label={t(locale, "localeLabel")}
              data-testid="locale-select"
              onChange={(e) => setLocale(e.target.value as Locale)}
            >
              <option value="en">English</option>
              <option value="id">Indonesia</option>
            </select>
          </label>
        </nav>
        <Outlet />
        <SwUpdatePrompt />
      </div>
    </LocaleCtx.Provider>
  );
}
