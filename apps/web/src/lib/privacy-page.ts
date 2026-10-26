import type { Localized } from "./localized";

/**
 * The /privacy page's own copy: the hero, the rights list, and the CCPA
 * opt-out statement. The factual register — controller, processors, retention,
 * erasure path, storage keys — stays in `privacy-notice.ts`, rendered by
 * `PrivacyNotice`; this module never restates a value the register owns.
 *
 * The rights list states statutory rights without inventing a response time or
 * a channel the operator has not recorded: the contact route is the register's.
 */
export const PRIVACY_PAGE = {
  eyebrow: { en: "Privacy notice", id: "Pemberitahuan privasi" },
  title: {
    en: "No accounts. No tracking. Your reading stays with you.",
    id: "Tanpa akun. Tanpa pelacakan. Bacaan Anda tinggal bersama Anda.",
  },
  lead: {
    en: "KajianQ is designed to hold as little about you as possible. This notice explains the little it does hold, why, and how you can remove it.",
    id: "KajianQ dirancang untuk menyimpan sesedikit mungkin tentang Anda. Pemberitahuan ini menjelaskan sedikit yang disimpannya, mengapa, dan bagaimana Anda menghapusnya.",
  },
  updatedLabel: { en: "Last updated", id: "Terakhir diperbarui" },
  updated: new Date("2026-10-26T00:00:00Z"),
  rightsTitle: { en: "Your rights", id: "Hak Anda" },
  rightsLead: {
    en: "Where the GDPR or a comparable law applies to you, you can exercise the rights below. Most of them are immediate here, because the data lives in your browser.",
    id: "Bila GDPR atau hukum serupa berlaku bagi Anda, Anda dapat menggunakan hak-hak berikut. Sebagian besarnya langsung berlaku di sini, karena datanya tinggal di peramban Anda.",
  },
  rights: [
    {
      title: { en: "Access a copy", id: "Mengakses salinan" },
      body: {
        en: "Your conversation is on your device, so the copy is the one you already read. The server-side record is described in the register below.",
        id: "Percakapan Anda ada di perangkat Anda, jadi salinannya adalah yang sudah Anda baca. Rekaman di server dijelaskan pada register di bawah.",
      },
    },
    {
      title: { en: "Correct inaccurate data", id: "Memperbaiki data yang keliru" },
      body: {
        en: "There is no profile to correct. A wrong answer is a content problem: report it with the feedback control anchored to its trace.",
        id: "Tidak ada profil yang perlu diperbaiki. Jawaban yang keliru adalah masalah isi: laporkan lewat kontrol masukan yang tertaut ke jejaknya.",
      },
    },
    {
      title: { en: "Delete your data", id: "Menghapus data Anda" },
      body: {
        en: "Clearing browser storage removes the local copy at once. The server-side erasure path is listed in the register below and cascades the whole session subtree.",
        id: "Menghapus penyimpanan peramban langsung membuang salinan lokal. Jalur penghapusan di server tercantum pada register di bawah dan menghapus seluruh pohon sesi.",
      },
    },
    {
      title: { en: "Limit what is kept", id: "Membatasi yang disimpan" },
      body: {
        en: "There is no profile and no secondary use: a question is processed to answer it and nothing else. Starting a new conversation keeps the previous one in this browser's history list, and clearing browser storage drops everything this browser holds.",
        id: "Tidak ada profil dan tidak ada pemakaian sekunder: pertanyaan diproses untuk dijawab, tidak untuk hal lain. Memulai percakapan baru menyimpan percakapan sebelumnya di daftar riwayat peramban ini, dan menghapus penyimpanan peramban membuang semua yang dipegang peramban ini.",
      },
    },
    {
      title: { en: "Erase the server-side record", id: "Menghapus rekaman di server" },
      body: {
        en: "The register below names the endpoint that erases the session, its messages, the answer traces and the feedback in one cascade. It is not a button in the app yet.",
        id: "Register di bawah menyebut endpoint yang menghapus sesi, pesannya, jejak jawaban, dan masukan dalam satu rantai. Belum tersedia sebagai tombol di aplikasi.",
      },
    },
    {
      title: { en: "Complain to a supervisory authority", id: "Mengadu ke otoritas pengawas" },
      body: {
        en: "You may complain to your national data-protection authority. The controller's public contact channel is listed below.",
        id: "Anda dapat mengadu ke otoritas perlindungan data nasional Anda. Kanal kontak publik pengendali tercantum di bawah.",
      },
    },
  ] as readonly { title: Localized; body: Localized }[],
  doNotSell: {
    title: { en: "Do Not Sell or Share", id: "Jangan Jual atau Bagikan" },
    body: {
      en: "KajianQ does not sell personal information and does not share it for cross-context behavioural advertising. There is no financial incentive programme and no penalty for exercising a privacy right. If you believe the service has handled your information otherwise, contact the controller through the channel below and we will review it.",
      id: "KajianQ tidak menjual informasi pribadi dan tidak membagikannya untuk iklan perilaku lintas konteks. Tidak ada program insentif keuangan dan tidak ada sanksi karena menggunakan hak privasi. Bila Anda menilai layanan menangani informasi Anda secara lain, hubungi pengendali melalui kanal di bawah dan akan ditinjau.",
    },
  },
} as const;
