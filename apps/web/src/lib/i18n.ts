import { createContext, useContext } from "react";

export type Locale = "en" | "id";

export const messages = {
  en: {
    appTitle: "KajianQ",
    homeTitle: "KajianQ",
    homeSubtitle:
      "An Islamic classical-knowledge chatbot built on the DARS engine. This is the v1 foundation shell; the chat interface arrives in a later milestone.",
    health: "API health",
    loading: "Loading…",
    schema: "Schema",
    env: "Environment",
    time: "Time",
    localeLabel: "Language",
    updateAvailable: "Update available",
    reload: "Reload",
  },
  id: {
    appTitle: "KajianQ",
    homeTitle: "KajianQ",
    homeSubtitle:
      "Chatbot pengetahuan Islam klasik di atas mesin DARS. Ini kerangka fondasi v1; antarmuka obrolan hadir di tonggak berikutnya.",
    health: "Kesehatan API",
    loading: "Memuat…",
    schema: "Skema",
    env: "Lingkungan",
    time: "Waktu",
    localeLabel: "Bahasa",
    updateAvailable: "Pembaruan tersedia",
    reload: "Muat ulang",
  },
} as const;

export type MessageKey = keyof (typeof messages)["en"];

/**
 * Selected locale, owned by the app shell. Lives here (not in the router) so
 * UI outside the route tree — the SW update prompt — can follow it too.
 */
export const LocaleCtx = createContext<Locale>("en");

export function useLocale(): Locale {
  return useContext(LocaleCtx);
}

export function t(locale: Locale, key: MessageKey): string {
  return messages[locale][key];
}

export function formatWhen(locale: Locale, date: Date): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
