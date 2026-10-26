/**
 * The consent card's copy (ADR-0063) and the history drawer's storage switch.
 * It lives beside the history copy for the same reason that one has its own
 * module: the message list is at the agentic-limits line cap, and
 * `i18n-messages` spreads this in so `MessageKey` covers these keys like any
 * other.
 */
export const consentMessages = {
  en: {
    consentEyebrow: "BEFORE YOU BEGIN",
    consentLead:
      "Under the privacy law that applies to you, we keep your conversation in this browser only if you agree.",
    consentBody:
      "KajianQ has no accounts, advertising, or tracking. Your question is sent to an AI service to compose an answer, and the server-side copy follows the retention window in the privacy notice.",
    consentKeep: "Keep my conversation here",
    consentDontKeep: "Don't keep anything",
    consentOffNote: "Browser storage is off: the conversation goes when the tab closes.",
    consentEnable: "Keep conversations in this browser",
    consentDisable: "Stop keeping them",
    notSavedLocally: "Not saved in this browser",
  },
  id: {
    consentEyebrow: "SEBELUM MULAI",
    consentLead:
      "Menurut hukum privasi yang berlaku, kami hanya menyimpan percakapan Anda di peramban ini jika Anda setuju.",
    consentBody:
      "KajianQ tanpa akun, iklan, atau pelacakan. Pertanyaan Anda dikirim ke layanan AI untuk menyusun jawaban, dan salinan di server mengikuti masa simpan pada pemberitahuan privasi.",
    consentKeep: "Simpan percakapan saya di sini",
    consentDontKeep: "Jangan simpan apa pun",
    consentOffNote: "Penyimpanan di peramban mati: percakapan hilang saat tab ditutup.",
    consentEnable: "Simpan percakapan di peramban ini",
    consentDisable: "Berhenti menyimpan",
    notSavedLocally: "Tidak disimpan di perangkat ini",
  },
} as const;
