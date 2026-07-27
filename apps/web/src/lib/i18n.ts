export type Locale = "en" | "id";

const messages = {
  en: {
    appTitle: "Notes",
    homeTitle: "Hello World",
    homeSubtitle: "Agentic template — local-first notes.",
    notes: "Notes",
    addNote: "Add note",
    title: "Title",
    body: "Body",
    save: "Save",
    delete: "Delete",
    empty: "No notes yet.",
    offline: "Offline — changes stay on this device.",
    syncing: "Syncing…",
    synced: "Synced",
    localeLabel: "Language",
    health: "API health",
    loading: "Loading…",
    schema: "Schema",
    env: "Environment",
    signIn: "Start session",
    signOut: "Delete account",
    updateAvailable: "Update available",
    reload: "Reload",
  },
  id: {
    appTitle: "Catatan",
    homeTitle: "Halo Dunia",
    homeSubtitle: "Template agentik — catatan lokal-dulu.",
    notes: "Catatan",
    addNote: "Tambah catatan",
    title: "Judul",
    body: "Isi",
    save: "Simpan",
    delete: "Hapus",
    empty: "Belum ada catatan.",
    offline: "Luring — perubahan tetap di perangkat ini.",
    syncing: "Menyinkronkan…",
    synced: "Tersinkron",
    localeLabel: "Bahasa",
    health: "Kesehatan API",
    loading: "Memuat…",
    schema: "Skema",
    env: "Lingkungan",
    signIn: "Mulai sesi",
    signOut: "Hapus akun",
    updateAvailable: "Pembaruan tersedia",
    reload: "Muat ulang",
  },
} as const;

export type MessageKey = keyof (typeof messages)["en"];

export function t(locale: Locale, key: MessageKey): string {
  return messages[locale][key];
}

export function formatWhen(locale: Locale, date: Date): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
