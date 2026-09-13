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
    tagline: "Islamic classical knowledge",
    themeToggle: "Toggle light or dark theme",
    conversationLabel: "Conversation",
    savedLocally: "Saved on your device",
    greeting: "Peace be upon you, reader.",
    emptyLine1: "Ask about the Quran, hadith, tafsir, and the classical tradition.",
    emptyLine2: "Each answer cites its sources.",
    suggestion1: "What is Ayat al-Kursi and what does it mean?",
    suggestion2: "Which authentic hadith speak about honesty?",
    suggestion3: "What do the classical kitab say about intention in deeds?",
    footerMeta: "One conversation · Every answer cites its sources · Saved on your device",
    warningLabel: "Warning",
    composerPlaceholder: "Ask about the Quran, hadith, or classical scholarship…",
    send: "Send",
    newSession: "New conversation",
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
    traceToggle: "How this answer was built",
    traceSourcesLabel: "Sources consulted",
    traceNoSources: "No sources were recorded for this answer.",
    traceTechnicalToggle: "Technical details",
    traceIntentLabel: "Router intent",
    traceSubqueriesLabel: "Sub-queries",
    traceChunksLabel: "Retrieved passages",
    traceScoreLabel: "score",
    traceModelsLabel: "Models used",
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
    tagline: "Pengetahuan Islam klasik",
    themeToggle: "Ganti tema terang atau gelap",
    conversationLabel: "Percakapan",
    savedLocally: "Tersimpan di perangkat Anda",
    greeting: "Assalamu’alaikum, pembaca.",
    emptyLine1: "Tanyakan tentang Al-Quran, hadits, tafsir, dan tradisi klasik.",
    emptyLine2: "Setiap jawaban mencantumkan sumbernya.",
    suggestion1: "Apa itu ayat kursi dan apa maknanya?",
    suggestion2: "Hadits apa saja yang shahih tentang kejujuran?",
    suggestion3: "Apa kata kitab klasik tentang niat dalam beramal?",
    footerMeta:
      "Satu percakapan · Setiap jawaban mencantumkan sumbernya · Tersimpan di perangkat Anda",
    warningLabel: "Peringatan",
    composerPlaceholder: "Tanyakan tentang Quran, hadits, atau tafsir…",
    send: "Kirim",
    newSession: "Percakapan baru",
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
    traceToggle: "Cara jawaban ini disusun",
    traceSourcesLabel: "Sumber yang dirujuk",
    traceNoSources: "Tidak ada sumber yang tercatat untuk jawaban ini.",
    traceTechnicalToggle: "Detail teknis",
    traceIntentLabel: "Intent router",
    traceSubqueriesLabel: "Sub-kueri",
    traceChunksLabel: "Cuplikan yang diambil",
    traceScoreLabel: "skor",
    traceModelsLabel: "Model yang digunakan",
  },
} as const;

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

export function formatWhen(locale: Locale, date: Date): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
