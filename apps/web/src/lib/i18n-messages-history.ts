/**
 * The conversation-history drawer's copy. It lives in its own module so the
 * growing message list stays under the agentic-limits line cap; `i18n-messages`
 * spreads it into both locales, so `MessageKey` covers these keys like any
 * other and the en/id parity test reads them there.
 */
export const historyMessages = {
  en: {
    historyOpen: "Conversation history",
    historyTitle: "Conversation history",
    historyLead: "Your conversations are kept only in this browser. Open one to continue it.",
    historyEmpty: "No conversations yet.",
    historyEmptyHint: "Starting a new conversation keeps the previous one here.",
    historyExpired: "Expired",
    historyExpiredHint: "This conversation is no longer on the server.",
    historyOpenFailed: "Could not open this conversation. Try again.",
    historyRemove: "Remove from list",
    historyClearAll: "Clear all",
    historyLocalNote:
      "The list lives in this browser. The server copy follows the retention window in the privacy notice.",
    historyUntitled: "Untitled conversation",
    historyJustNow: "just now",
    historyMinutesAgo: "{count} min ago",
    historyHoursAgo: "{count} h ago",
    historyDaysAgo: "{count} d ago",
    historyClose: "Close conversation history",
  },
  id: {
    historyOpen: "Riwayat percakapan",
    historyTitle: "Riwayat percakapan",
    historyLead: "Percakapan Anda hanya tersimpan di peramban ini. Buka satu untuk melanjutkannya.",
    historyEmpty: "Belum ada percakapan.",
    historyEmptyHint: "Saat Anda memulai percakapan baru, yang sebelumnya tetap tersimpan di sini.",
    historyExpired: "Kedaluwarsa",
    historyExpiredHint: "Percakapan ini sudah tidak tersedia di server.",
    historyOpenFailed: "Tidak bisa membuka percakapan ini. Coba lagi.",
    historyRemove: "Hapus dari daftar",
    historyClearAll: "Hapus semua",
    historyLocalNote:
      "Daftar ini tersimpan di peramban. Salinan di server mengikuti masa simpan pada pemberitahuan privasi.",
    historyUntitled: "Percakapan tanpa judul",
    historyJustNow: "baru saja",
    historyMinutesAgo: "{count} mnt lalu",
    historyHoursAgo: "{count} jam lalu",
    historyDaysAgo: "{count} hari lalu",
    historyClose: "Tutup riwayat percakapan",
  },
} as const;
