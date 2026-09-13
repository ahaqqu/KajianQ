import { Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { LocaleCtx, LocaleSetterCtx, type Locale } from "../lib/i18n";
import { SwUpdatePrompt } from "../lib/sw-update";

/**
 * App shell: owns the selected locale and mounts the SW update prompt inside
 * the locale provider so its copy follows the language switch. The visual
 * chrome (header, theme toggle) lives in the routes' own views — the chat is
 * the product's home and owns the full reference layout.
 */
export function Shell() {
  // Indonesian-first (SPECS §2.1): the product defaults to Bahasa Indonesia.
  const [locale, setLocale] = useState<Locale>("id");

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <LocaleCtx.Provider value={locale}>
      <LocaleSetterCtx.Provider value={setLocale}>
        <Outlet />
        <SwUpdatePrompt />
      </LocaleSetterCtx.Provider>
    </LocaleCtx.Provider>
  );
}
