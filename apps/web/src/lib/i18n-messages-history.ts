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
    historyLead:
      "The conversations you allow are kept in this browser. Open one to continue it, or download a copy.",
    historyEmpty: "No conversations yet.",
    historyEmptyHint: "Your previous conversations will appear here.",
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
    historyDownload: "Download conversation",
    historyDownloadFailed: "Could not prepare the file. Try again.",
    exportYou: "You",
    exportAssistant: "KajianQ",
    exportTruncated: "The beginning of this conversation is not included.",
  },
  id: {
    historyOpen: "Riwayat percakapan",
    historyTitle: "Riwayat percakapan",
    historyLead:
      "Percakapan yang Anda izinkan tersimpan di peramban ini. Buka satu untuk melanjutkannya, atau unduh salinannya.",
    historyEmpty: "Belum ada percakapan.",
    historyEmptyHint: "Percakapan sebelumnya akan muncul di sini.",
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
    historyDownload: "Unduh percakapan",
    historyDownloadFailed: "Tidak bisa menyiapkan berkasnya. Coba lagi.",
    exportYou: "Anda",
    exportAssistant: "KajianQ",
    exportTruncated: "Awal percakapan ini tidak disertakan.",
  },
} as const;
