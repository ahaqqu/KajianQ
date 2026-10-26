import type { Localized } from "./localized";

/**
 * The About page's display copy. The functional sentences — the mission, the
 * three working principles, the privacy summary — stay in `i18n-messages.ts`
 * beside the rest of the product copy; this module holds only the page's
 * headline voices, which no other surface reuses.
 */
export const ABOUT_COPY = {
  eyebrow: { en: "About KajianQ", id: "Tentang KajianQ" },
  title: {
    en: "Built for reading slowly, asking carefully, and following the sources.",
    id: "Dibangun untuk membaca perlahan, bertanya dengan cermat, dan mengikuti sumbernya.",
  },
  purposeTitle: { en: "A doorway, not the final word.", id: "Pintu masuk, bukan kata akhir." },
  principlesTitle: { en: "Trust is a practice.", id: "Kepercayaan adalah praktik." },
  privacyTitle: {
    en: "Your reading stays with you.",
    id: "Bacaan Anda tinggal bersama Anda.",
  },
} as const satisfies Record<string, Localized>;
