import type { RetentionItem } from "./privacy-notice-types";

/**
 * The retention values the notice states: **ADR-0043 decision 4 in data form**
 * (mirrored by the Art. 30 record §6). A row is `current` when the code behind
 * it exists today (the 30-day session TTL in the RagStore adapter, the erasure
 * cascade) and `planned` with its ticket when it does not (#180's access-log
 * and backup measures, #181's snapshot retention) — a claim never outruns the
 * code that backs it.
 *
 * There is deliberately no separate age-based deletion of chat rows: a session
 * that keeps being used keeps its transcript, so anonymous chat retention is
 * 30 days of inactivity plus on-demand erasure. That is a product decision,
 * stated rather than implied.
 */

/**
 * The retention values (ADR-0043 decision 4, mirrored by the Art. 30 record
 * §6). There is deliberately **no separate age-based deletion of chat rows**: a
 * session that keeps being used keeps its transcript, so the effective
 * retention for anonymous chat is 30 days of inactivity plus on-demand
 * erasure. That is a product decision, stated here rather than implied.
 */
export const RETENTION: readonly RetentionItem[] = [
  {
    id: "sessions",
    status: "current",
    what: {
      id: "Sesi anonim dan seluruh isinya",
      en: "Anonymous sessions and everything they own",
    },
    window: {
      id: "30 hari tanpa aktivitas. Tidak ada penghapusan berbasis usia terpisah untuk baris obrolan: percakapan yang terus dipakai tetap menyimpan transkripnya, sehingga masa simpan obrolan anonim adalah 30 hari tanpa aktivitas.",
      en: "30 days of inactivity. There is no separate age-based deletion of chat rows: a session that keeps being used keeps its transcript, so anonymous chat retention is 30 days of inactivity.",
    },
    enforcedBy: {
      id: "Token hanya disimpan sebagai hash SHA-256, kedaluwarsa ditegakkan saat dibaca, dan cron malam membersihkan sesi kedaluwarsa beserta pengguna anonim yang tidak lagi punya sesi.",
      en: "Tokens are stored only as a SHA-256 hash, expiry is enforced on read, and a nightly cron reclaims expired sessions together with the anonymous users left without one.",
    },
  },
  {
    id: "erasure",
    status: "current",
    what: {
      id: "Penghapusan atas permintaan",
      en: "Erasure on demand",
    },
    window: {
      id: "Segera — satu panggilan menghapus sesi, obrolan, trace, dan masukan sekaligus.",
      en: "Immediate — one call removes sessions, chat, traces, and feedback together.",
    },
    enforcedBy: {
      id: "Endpoint penghapusan dengan kaskade di lapisan penyimpanan (hak Art. 17).",
      en: "The erasure endpoint, cascading at the storage layer (the Art. 17 path).",
    },
  },
  {
    id: "rate-counters",
    status: "current",
    what: {
      id: "Penghitung pembatas laju per IP",
      en: "Per-IP rate-limit counters",
    },
    window: {
      id: "Status runtime sementara — bertahan hanya selama penghitungnya hidup.",
      en: "Transient runtime state — it lives only as long as the counter does.",
    },
    enforcedBy: {
      id: "Disimpan di memori dan dinamai dengan digest, tidak pernah ditulis ke berkas log.",
      en: "Kept in memory and named by a digest, never written to a log file.",
    },
  },
  {
    id: "api-logs",
    status: "current",
    what: {
      id: "Log API terstruktur",
      en: "Structured API logs",
    },
    window: {
      id: "Hanya id korelasi — tanpa alamat IP.",
      en: "A correlation id only — no IP address.",
    },
    enforcedBy: {
      id: "Pencatat terstruktur aplikasi; alamat IP tidak pernah masuk ke baris lognya.",
      en: "The app's structured logger; an IP address never enters its log lines.",
    },
  },
  {
    id: "access-logs",
    status: "current",
    what: {
      id: "Log akses reverse proxy",
      en: "Reverse-proxy access logs",
    },
    window: {
      id: "14 hari — dipilih sengaja agar log tidak tumbuh tanpa batas dan tidak menjadi catatan utama siapa bertanya apa.",
      en: "14 days — deliberately chosen so the log neither grows unbounded nor becomes the de-facto record of who asked what.",
    },
    enforcedBy: {
      id: "logrotate harian dengan batas ukuran; segmen yang sudah diputar dihapus setelah 14 hari.",
      en: "Daily, size-capped logrotate; rotated segments are deleted after 14 days.",
    },
  },
  {
    id: "backups",
    status: "current",
    what: {
      id: "Cadangan basis data",
      en: "Database backups",
    },
    window: {
      id: "Rotasi 30 hari — sama dengan masa simpan sesi, sehingga cadangan tidak dapat hidup jauh lebih lama daripada datanya. Kunci enkripsinya dipegang di luar repo.",
      en: "30-day rolling — the session lifetime, so a backup cannot meaningfully outlive the data it holds. The encryption key is held outside the repo.",
    },
    enforcedBy: {
      id: "Enkripsi saat diam dengan kunci yang dirotasi harian; pemulihan cadangan mengulang penghapusan untuk jendela yang dipulihkan.",
      en: "Encryption at rest with a key rotated daily; a restore re-applies erasure for the restored window.",
    },
  },
  {
    id: "snapshots",
    status: "current",
    what: {
      id: "Arsip snapshot ingest yang sudah digantikan",
      en: "Superseded ingest snapshot archives",
    },
    window: {
      id: "Dihapus 30 hari setelah penerusnya terverifikasi — penghapusan eksplisit per label, bukan penimpaan.",
      en: "Deleted 30 days after their successor was verified — an explicit deletion by label, never an overwrite.",
    },
    enforcedBy: {
      id: "Alur label snapshot yang sudah ada; arsip yang membawa data pribadi dienkripsi saat diam.",
      en: "The existing snapshot-label flow; an archive carrying personal data is encrypted at rest.",
    },
  },
];
