import { createContext, useContext } from "react";
import { messages } from "./i18n-messages";

export type Locale = "en" | "id";

/** The en/id copy (`i18n-messages.ts`), re-exported for its direct readers. */
export { messages };

export type MessageKey = keyof (typeof messages)["en"];

/**
 * Selected locale, owned by the app shell. Lives here (not in the router) so
 * UI outside the route tree — the SW update prompt — can follow it too.
 */
export const LocaleCtx = createContext<Locale>("en");

/** The shell's locale setter, shared the same way (the header's language select). */
export const LocaleSetterCtx = createContext<(locale: Locale) => void>(() => {});

export function useLocale(): Locale {
  return useContext(LocaleCtx);
}

export function useLocaleSetter(): (locale: Locale) => void {
  return useContext(LocaleSetterCtx);
}

export function t(locale: Locale, key: MessageKey): string {
  return messages[locale][key];
}

/**
 * A message with its `{name}` placeholders substituted (thermo-review B2,
 * #256). This is the app's one substitution convention: the placeholder
 * syntax belongs to the copy in `messages`, and the call site passes values —
 * it never reaches into the string itself. An unknown placeholder is left
 * verbatim rather than emptied or guessed, so a missing value is visibly
 * wrong instead of silently absent.
 */
export function formatMessage(
  locale: Locale,
  key: MessageKey,
  params: Readonly<Record<string, string | number>>,
): string {
  return t(locale, key).replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}

/** A number in the reader's locale (id "2.000", en "2,000"), beside `formatWhen`. */
export function formatNumber(locale: Locale, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatWhen(locale: Locale, date: Date): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
