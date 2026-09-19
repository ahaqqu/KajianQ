import type { Localized } from "./localized";

/**
 * The erasure path the notice points at (#179's recorded gap): the endpoint
 * that exists — `DELETE /v1/auth/me`, cascading sessions, chat, traces, and
 * feedback — and the honest statement that no in-product control reaches it
 * yet. `uiAffordance` fixes the gap as data, so a future erase-control ticket
 * flips it rather than rewording the copy.
 */

export const ERASURE = {
  method: "DELETE",
  path: "/v1/auth/me",
  /** `present` once an in-app control reaches the endpoint (#179's follow-up). */
  uiAffordance: "absent",
  what: {
    id: "Satu panggilan menghapus sesi anonim Anda beserta seluruh pohonnya: sesi, sesi obrolan dan pesannya, trace setiap jawaban, dan masukan — hak penghapusan Art. 17 sebagai satu kaskade.",
    en: "One call erases your anonymous session and its whole subtree: the session, its chat sessions and messages, every answer's trace, and feedback — the Art. 17 right as a single cascade.",
  },
  noUiNote: {
    id: "Antarmuka belum punya tombol untuk ini: endpoint di atas adalah jalur penghapusan yang berlaku hari ini, dipanggil dengan token sesi Anda sendiri. Kontrol yang mudah ditemukan belum ada dan dicatat apa adanya di sini, bukan diganti dengan tombol yang belum ada.",
    en: "The interface has no button for this yet: the endpoint above is the working erasure path today, called with your own session token. A discoverable control does not exist yet, and this notice records that gap rather than inventing an affordance.",
  },
  localNote: {
    id: "Menghapus penyimpanan peramban — atau memulai percakapan baru — hanya membuang id sesi di perangkat Anda. Salinan di server tetap ada sampai Anda memanggil endpoint ini atau sesi kedaluwarsa karena 30 hari tanpa aktivitas.",
    en: "Clearing your browser storage — or starting a new conversation — only drops the session id on your device. The server-side copy stays until you call this endpoint or the session expires through 30 days of inactivity.",
  },
} as const satisfies {
  method: string;
  path: string;
  uiAffordance: "absent" | "present";
  what: Localized;
  noUiNote: Localized;
  localNote: Localized;
};

/**
 * The controller line (Art. 13(1)(a)), mirroring the Art. 30 record §2. A
 * dedicated privacy contact and a postal address are owner-supplied values the
 * record deliberately does not invent, so the notice names the real public
 * channel and says the rest is not yet recorded.
 */
export const CONTROLLER = {
  name: "Angga (@ahaqqu)",
  body: {
    id: "KajianQ dijalankan oleh operator perorangannya sebagai pengendali data (controller, Art. 4(7) GDPR). Kanal kontak publik yang ada hari ini adalah akun GitHub @ahaqqu; kontak privasi khusus dan alamat pos adalah data yang disediakan pemilik dan belum tercatat.",
    en: "KajianQ is operated by its individual operator as the data controller (Art. 4(7) GDPR). The public contact channel today is the GitHub account @ahaqqu; a dedicated privacy contact and a postal address are owner-supplied and not yet recorded.",
  },
} as const satisfies { name: string; body: Localized };
