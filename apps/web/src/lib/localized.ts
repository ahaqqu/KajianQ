/**
 * The app's content-module convention: one string per locale, rendered in the
 * reader's locale. Declared once here so every typed content module — the
 * collection register (`collections-types.ts`) and the privacy notice
 * (`privacy-notice.ts`) — shares one definition instead of a copy per module.
 */
export type Localized = { en: string; id: string };
