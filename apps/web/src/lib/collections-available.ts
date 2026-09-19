import type { CollectionEntry } from "./collections-types";

/**
 * Available entries — every source ingested and citable today. Mirrors the
 * register in `NOTICES/DATASETS.md` (that file keeps the licenses; each entry
 * here keeps only a one-line attribution note) and `SPECS.md` §4.1.
 */
export const COLLECTION_AVAILABLE: readonly CollectionEntry[] = [
  {
    id: "quran-tanzil-uthmani",
    status: "available",
    category: "scripture",
    century: { en: "Revealed 610–632 CE", id: "Diturunkan 610–632 M" },
    title: { en: "Quran — Uthmani text", id: "Al-Quran — teks Utsmani" },
    author: { en: "Tanzil.net · Uthmani edition", id: "Tanzil.net · edisi Utsmani" },
    description: {
      en: "The Arabic primary evidence text: all 6,236 ayah in the Uthmani script, ingested per surah and per ayah.",
      id: "Teks bukti utama berbahasa Arab: seluruh 6.236 ayat dalam aksara Utsmani, diingest per surah dan per ayat.",
    },
    attribution: {
      en: "Tanzil Terms of Use — redistributed verbatim with attribution.",
      id: "Ketentuan Penggunaan Tanzil — disebarkan apa adanya dengan atribusi.",
    },
  },
  {
    id: "quran-kemenag-id",
    status: "available",
    category: "scripture",
    century: { en: "Modern Indonesian translation", id: "Terjemahan Indonesia modern" },
    title: { en: "Quran — Indonesian translation", id: "Al-Quran — terjemahan Indonesia" },
    author: { en: "Kementerian Agama RI", id: "Kementerian Agama RI" },
    description: {
      en: "The Indonesian secondary track aligned to each ayah, so an answer can carry the Arabic original and its translation together.",
      id: "Jalur sekunder bahasa Indonesia yang selaras dengan tiap ayat, sehingga jawaban dapat memuat teks Arab asli beserta terjemahannya.",
    },
    attribution: {
      en: "Kemenag RI edition; redistribution gated by the licensing-verification prerequisite (issue #2).",
      id: "Edisi Kemenag RI; penyebaran digantungkan pada prasyarat verifikasi lisensi (issue #2).",
    },
  },
  {
    id: "quran-arabic-corpus-morphology",
    status: "available",
    category: "scripture",
    century: { en: "Quranic Arabic Corpus v0.4", id: "Quranic Arabic Corpus v0.4" },
    title: { en: "Quranic Arabic Corpus morphology", id: "Morfologi Quranic Arabic Corpus" },
    author: { en: "Leeds · Corpus v0.4", id: "Leeds · Korpus v0.4" },
    description: {
      en: "Hand-verified lemma and root for every Arabic token of the Quran, aligned to the same Uthmani text — the Arabic channel retrieval and terminology build on.",
      id: "Lemma dan akar kata yang diverifikasi manual untuk setiap token Arab Al-Quran, selaras dengan teks Utsmani yang sama — dasar kanal Arab dan pembangunan terminologi.",
    },
    attribution: {
      en: "GPL corpus, consumed at build and ingestion time.",
      id: "Korpus GPL, dipakai pada saat build dan ingest.",
    },
  },
  {
    id: "hadith-fawazahmed0",
    status: "available",
    category: "hadith",
    century: {
      en: "Compiled 2nd–3rd c. AH (d. 179–256 H)",
      id: "Dikompilasi abad 2–3 H (w. 179–256 H)",
    },
    title: { en: "Hadith collections — seven", id: "Koleksi hadits — tujuh" },
    author: {
      en: "Bukhari · Muslim · Abu Dawud · Tirmidhi · Nasai · Ibn Majah · Muwatta Malik",
      id: "Bukhari · Muslim · Abu Dawud · Tirmidzi · Nasa'i · Ibnu Majah · Muwatta Malik",
    },
    description: {
      en: "Arabic matn, Indonesian translation, book and section structure, and a headline grade per hadith — the collections answered from today.",
      id: "Matn Arab, terjemahan Indonesia, struktur kitab dan bab, serta satu derajat utama per hadits — koleksi yang dijawab hari ini.",
    },
    attribution: {
      en: "fawazahmed0/hadith-api (Unlicense); grade consolidation follows dhaif-wins (ADR-0026).",
      id: "fawazahmed0/hadith-api (Unlicense); konsolidasi derajat mengikuti dhaif-menang (ADR-0026).",
    },
  },
  {
    id: "hadith-sunnah-com",
    status: "available",
    category: "hadith",
    century: { en: "Upstream text source", id: "Sumber teks hulu" },
    title: { en: "Sunnah.com hadith texts", id: "Teks hadits Sunnah.com" },
    author: { en: "sunnah.com", id: "sunnah.com" },
    description: {
      en: "The upstream origin of the Arabic and English hadith editions, attributed alongside every collection above.",
      id: "Asal hulu edisi hadits Arab dan Inggris, diatribusikan bersama setiap koleksi di atas.",
    },
    attribution: {
      en: "Attribution owed to sunnah.com as the upstream source of the ingested editions.",
      id: "Atribusi diberikan kepada sunnah.com sebagai sumber hulu edisi yang diingest.",
    },
  },
];
