import { consentMessages } from "./i18n-messages-consent";
import { historyMessages } from "./i18n-messages-history";

/**
 * The chat surface's copy, one object for `i18n-messages` to spread: the history
 * drawer and the consent card each keep their own module under the line cap,
 * and both locales stay key-for-key with the rest of the message list.
 */
export const chatMessages = {
  en: { ...historyMessages.en, ...consentMessages.en },
  id: { ...historyMessages.id, ...consentMessages.id },
} as const;
