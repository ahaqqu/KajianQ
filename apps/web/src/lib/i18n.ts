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
    feedbackAria: "Rate this answer",
    feedbackUp: "Helpful",
    feedbackDown: "Not helpful",
    feedbackThanks: "Thanks — your feedback is recorded.",
    feedbackError: "Feedback failed to send. Try again.",
    flagWrongCitation: "Wrong citation",
    flagIrrelevantChunk: "Irrelevant passage",
    flagBadTranslation: "Bad machine translation",
    flagQuestionableGrade: "Questionable grade",
    navLabel: "Main navigation",
    navChat: "Chat",
    navCollection: "Collection",
    navAbout: "About",
    navMenuOpen: "Open navigation menu",
    navMenuClose: "Close navigation menu",
    aboutTitle: "About KajianQ",
    aboutIntro:
      "KajianQ is an open-source Islamic classical-knowledge chatbot. It answers in Indonesian and English over original Arabic sources — the Quran, the hadith, and the kitab of the classical tradition — and names what it used.",
    aboutMissionLabel: "Mission",
    aboutMissionBody:
      "KajianQ orients; it does not claim authority. It is a doorway into the classical sources, never the final word: the matn stays distinct from the sharh written about it, and every answer points back to the text it came from.",
    aboutPrinciplesLabel: "Working principles",
    aboutPrincipleSourceTitle: "Name the source",
    aboutPrincipleSourceBody:
      "Every answer cites its sources. The Trace panel shows how it was built — the router intent, the sub-queries, the retrieved passages with their scores, and the model that composed it.",
    aboutPrincipleDifferenceTitle: "Preserve difference",
    aboutPrincipleDifferenceBody:
      "Scholarly differences are shown as positions, never merged into one. Answers are madzhab-aware: the Syafi'i view leads by default, other madzhab appear when the corpus covers them, and a gap in the corpus is stated rather than filled in.",
    aboutPrincipleThresholdTitle: "Know the threshold",
    aboutPrincipleThresholdBody:
      "KajianQ does not issue fatwa. Every answer closes with a disclaimer pointing to qualified ulama for legal rulings, and a hadith graded weak (dhaif) is always flagged.",
    aboutPrivacyLabel: "Privacy",
    aboutPrivacyBody:
      "Conversations are anonymous and local-first: the session lives on your device and ends with it (ADR-0017 anonymous sessions). Your theme and language preference stay on your device too, and no account is ever required.",
    aboutCtaChat: "Start a chat",
    aboutCtaCollection: "Browse the collection",
    collectionTitle: "The collection",
    collectionIntro:
      "A starting map of what KajianQ draws on — not a substitute for the complete editions, and not a substitute for qualified teachers. Entries marked Available are ingested and citable today; entries marked Planned are registered work, listed so the direction is visible.",
    collectionAvailableLabel: "Available",
    collectionPlannedLabel: "Planned",
    collectionAvailableSection: "Available now",
    collectionPlannedSection: "Planned",
    collectionEmpty: "Nothing in this category yet.",
    collectionPlannedPrefix: "planned",
    collectionAttributionLabel: "Attribution",
    collectionFilterAll: "All",
    collectionFilterScripture: "Scripture",
    collectionFilterHadith: "Hadith",
    collectionFilterTafsir: "Tafsir",
    collectionFilterKitab: "Kitab · Law",
    collectionFilterTheology: "Theology",
    collectionFilterSpirituality: "Spirituality",
    collectionFilterTerminology: "Terminology",
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
    feedbackAria: "Nilai jawaban ini",
    feedbackUp: "Membantu",
    feedbackDown: "Tidak membantu",
    feedbackThanks: "Terima kasih — masukan Anda tercatat.",
    feedbackError: "Masukan gagal terkirim. Coba lagi.",
    flagWrongCitation: "Kutipan salah",
    flagIrrelevantChunk: "Cuplikan tidak relevan",
    flagBadTranslation: "Terjemahan mesin buruk",
    flagQuestionableGrade: "Derajat diragukan",
    navLabel: "Navigasi utama",
    navChat: "Obrolan",
    navCollection: "Koleksi",
    navAbout: "Tentang",
    navMenuOpen: "Buka menu navigasi",
    navMenuClose: "Tutup menu navigasi",
    aboutTitle: "Tentang KajianQ",
    aboutIntro:
      "KajianQ adalah chatbot pengetahuan Islam klasik yang bersumber terbuka. Ia menjawab dalam bahasa Indonesia dan Inggris di atas sumber Arab aslinya — Al-Quran, hadits, dan kitab tradisi klasik — dan menyebut apa yang dipakainya.",
    aboutMissionLabel: "Misi",
    aboutMissionBody:
      "KajianQ memberi arah, bukan mengklaim otoritas. Ia pintu masuk ke sumber-sumber klasik, bukan kata akhir: matn dijaga tetap terpisah dari sharh yang ditulis atasnya, dan setiap jawaban menunjuk kembali ke teks asalnya.",
    aboutPrinciplesLabel: "Prinsip kerja",
    aboutPrincipleSourceTitle: "Sebutkan sumbernya",
    aboutPrincipleSourceBody:
      "Setiap jawaban mencantumkan sumbernya. Panel Trace menunjukkan bagaimana jawaban itu disusun — intent router, sub-kueri, cuplikan yang diambil beserta skornya, dan model yang menyusunnya.",
    aboutPrincipleDifferenceTitle: "Jaga perbedaan",
    aboutPrincipleDifferenceBody:
      "Perbedaan pendapat ulama disajikan sebagai posisi masing-masing, tidak dilebur jadi satu. Jawaban sadar madzhab: pandangan Syafi'i memimpin secara bawaan, madzhab lain tampil bila korpus mencakupnya, dan celah korpus dinyatakan apa adanya, bukan diisi karangan.",
    aboutPrincipleThresholdTitle: "Kenali batasnya",
    aboutPrincipleThresholdBody:
      "KajianQ tidak menetapkan fatwa. Setiap jawaban ditutup dengan penyangkalan yang mengarahkan ke ulama yang mumpuni untuk keputusan hukum, dan hadits yang berderajat lemah (dhaif) selalu ditandai.",
    aboutPrivacyLabel: "Privasi",
    aboutPrivacyBody:
      "Percakapan bersifat anonim dan mengutamakan perangkat Anda: sesi tersimpan di perangkat Anda dan berakhir bersamanya (ADR-0017 sesi anonim). Preferensi tema dan bahasa pun tetap di perangkat Anda, dan tidak diperlukan akun.",
    aboutCtaChat: "Mulai obrolan",
    aboutCtaCollection: "Telusuri koleksi",
    collectionTitle: "Koleksi",
    collectionIntro:
      "Peta awal sumber yang dipakai KajianQ — bukan pengganti edisi lengkap, dan bukan pengganti guru yang mumpuni. Entri bertanda Tersedia sudah diingest dan dapat dikutip hari ini; entri bertanda Direncanakan adalah pekerjaan yang sudah terdaftar, ditampilkan agar arahnya terlihat.",
    collectionAvailableLabel: "Tersedia",
    collectionPlannedLabel: "Direncanakan",
    collectionAvailableSection: "Tersedia sekarang",
    collectionPlannedSection: "Direncanakan",
    collectionEmpty: "Belum ada apa pun di kategori ini.",
    collectionPlannedPrefix: "direncanakan",
    collectionAttributionLabel: "Atribusi",
    collectionFilterAll: "Semua",
    collectionFilterScripture: "Kitab Suci",
    collectionFilterHadith: "Hadits",
    collectionFilterTafsir: "Tafsir",
    collectionFilterKitab: "Kitab · Fikih",
    collectionFilterTheology: "Akidah",
    collectionFilterSpirituality: "Tasawuf",
    collectionFilterTerminology: "Terminologi",
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
