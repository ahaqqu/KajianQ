import type { CollectionEntry } from "./collections-types";

/**
 * Planned registrations outside the priority-kitab and author-corpora lists:
 * tafsir (`SPECS.md` §4.1, not yet ticketed), the next hadith collection that
 * fits the staging storage cap (issue #141), and the license-vetted seed
 * sources for the terminology concept graph (issue #24, ADR-0014).
 */
export const COLLECTION_PLANNED_SOURCES: readonly CollectionEntry[] = [
  {
    id: "tafsir-classics",
    status: "planned",
    category: "tafsir",
    century: { en: "4th–9th c. AH · d. 310–774 H", id: "Abad 4–9 H · w. 310–774 H" },
    title: {
      en: "Tafsir — Ibnu Katsir, Jalalayn, Tabari",
      id: "Tafsir — Ibnu Katsir, Jalalain, Thabari",
    },
    author: { en: "Tanzil / Quran.com editions", id: "Edisi Tanzil / Quran.com" },
    description: {
      en: "Classical Quran commentary, planned from public-domain editions and kept distinct from the scripture it explains.",
      id: "Tafsir Al-Quran klasik, direncanakan dari edisi domain publik dan dijaga terpisah dari kitab suci yang dijelaskannya.",
    },
    planRef: "SPECS §4.1",
  },
  {
    id: "hadith-staging-next",
    status: "planned",
    category: "hadith",
    century: { en: "Staging · within the free-plan cap", id: "Staging · dalam batas paket gratis" },
    title: {
      en: "One more hadith collection on staging",
      id: "Satu koleksi hadits lagi di staging",
    },
    author: { en: "Tirmidhi · Ibn Majah · Abu Dawud", id: "Tirmidzi · Ibnu Majah · Abu Dawud" },
    description: {
      en: "One further collection fits the free-plan storage cap and is planned incrementally, without re-embedding what is already ingested.",
      id: "Satu koleksi lagi masih muat dalam batas penyimpanan paket gratis dan direncanakan secara bertahap, tanpa menyematkan ulang yang sudah diingest.",
    },
    planRef: "#141",
  },
  {
    id: "terminology-seed-sources",
    status: "planned",
    category: "terminology",
    century: { en: "Seed sources · concept graph", id: "Sumber benih · graf konsep" },
    title: { en: "Terminology concept graph seeds", id: "Benih graf konsep terminologi" },
    author: {
      en: "QSAC · Arabic WordNet · Wordnet Bahasa · CILI · Lane's Lexicon",
      id: "QSAC · Arabic WordNet · Wordnet Bahasa · CILI · Lane's Lexicon",
    },
    description: {
      en: "License-vetted seeds for the bilingual terminology concept graph that powers Arabic query expansion — each gets its own register row when ingested.",
      id: "Benih berlisensi bersih untuk graf konsep terminologi dwibahasa yang menggerakkan perluasan kueri Arab — masing-masing mendapat baris register sendiri saat diingest.",
    },
    planRef: "ADR-0014 · #24",
  },
];
