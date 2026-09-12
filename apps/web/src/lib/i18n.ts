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
    chatEmptyTitle: "Start asking",
    chatEmptyHint: "Ask about the Islamic classical kitab — Quran and hadith first.",
    composerPlaceholder: "Ask something…",
    send: "Send",
    newSession: "New session",
    stagedContext: "Retrieving context…",
    stagedReview: "Checking citations…",
    stagedCompose: "Composing the answer…",
    dhaifWarningCard:
      "[Warning] The cited hadith is graded weak (dhaif); it may not be used as a primary proof.",
    gradeLabel: "Grade",
    sourceLabel: "Source",
    arabicOriginal: "Original Arabic text",
    translationLabel: "Translation",
    citationChipAria: "View source for citation",
    closeSheet: "Close",
    youLabel: "You",
    offlineBanner: "You are offline — chat needs a network connection.",
    errorRateLimited: "Too many requests. Please wait a moment and try again.",
    errorUnavailable: "The service is temporarily unavailable. Please try again later.",
    errorGeneric: "Something went wrong. Please try again.",
    loadError: "Failed to load the conversation.",
    transcriptTruncated: "Older messages are not shown — only the newest ones are kept.",
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
    chatEmptyTitle: "Mulai bertanya",
    chatEmptyHint:
      "Ajukan pertanyaan seputar kitab klasik Islam — awali dengan Al-Quran dan hadits.",
    composerPlaceholder: "Tanyakan sesuatu…",
    send: "Kirim",
    newSession: "Sesi baru",
    stagedContext: "Mengambil konteks…",
    stagedReview: "Memeriksa sitasi…",
    stagedCompose: "Menyusun jawaban…",
    dhaifWarningCard:
      "[Peringatan] Hadits yang dikutip berderajat lemah (dhaif); tidak dapat dijadikan dalil utama.",
    gradeLabel: "Derajat",
    sourceLabel: "Sumber",
    arabicOriginal: "Teks Arab asli",
    translationLabel: "Terjemahan",
    citationChipAria: "Lihat sumber sitasi",
    closeSheet: "Tutup",
    youLabel: "Anda",
    offlineBanner: "Anda sedang offline — obrolan butuh koneksi internet.",
    errorRateLimited: "Terlalu banyak permintaan. Tunggu sejenak lalu coba lagi.",
    errorUnavailable: "Layanan sedang tidak tersedia. Coba lagi nanti.",
    errorGeneric: "Terjadi kesalahan. Silakan coba lagi.",
    loadError: "Gagal memuat percakapan.",
    transcriptTruncated: "Pesan lebih lama tidak ditampilkan — hanya yang terbaru yang disimpan.",
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
