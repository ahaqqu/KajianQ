import { createContext, useContext } from "react";

export type Locale = "en" | "id";

export const messages = {
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
    syncError: "Sync error — retrying…",
    localeLabel: "Language",
    health: "API health",
    loading: "Loading…",
    schema: "Schema",
    env: "Environment",
    time: "Time",
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
    syncError: "Gagal menyinkronkan — mencoba lagi…",
    localeLabel: "Bahasa",
    health: "Kesehatan API",
    loading: "Memuat…",
    schema: "Skema",
    env: "Lingkungan",
    time: "Waktu",
    signIn: "Mulai sesi",
    signOut: "Hapus akun",
    updateAvailable: "Pembaruan tersedia",
    reload: "Muat ulang",
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
