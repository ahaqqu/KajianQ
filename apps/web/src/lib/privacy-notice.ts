import type { Localized } from "./localized";

/**
 * The `/about` privacy notice's content model (#179, GDPR-C): who processes a
 * visitor's data, how long it is kept, and how to erase it — the Art. 13(1)(e)
 * recipients/retention disclosure, rendered by `components/PrivacyNotice`.
 *
 * The repo's markdown registers are never imported at runtime (a production
 * bundle cannot read repo files), so this module mirrors them and must be kept
 * true to:
 *
 *   - `adr/0043-netcup-vps-hosting-gdpr-posture.md` — decision 3 (the
 *     sub-processor register) and decision 4 (the retention values). ADR-0043
 *     is the **source of truth**: the register's rows, tiers, and verdicts come
 *     from there, never from prose written here. The Tier column is a
 *     compliance field, not a cost note.
 *   - `docs/GDPR-ARTICLE-30-RECORD.md` — the Art. 30 rendering of the same
 *     values (§2 controller, §6 retention, §8 recipients).
 *   - `packages/infra/src/providers/models.json` — the register's
 *     machine-checkable shadow (`freeTier`, `personalDataAllowed`).
 *   - `apps/api/src/routes/auth.ts` — the erasure endpoint the notice points at.
 *
 * Two honesty rules run through this module, and the tests pin both:
 *
 *   1. **Status, not tense.** The VPS migration (#181) has not happened: today
 *      the API runs on Cloudflare Workers and the database on Neon. Every row
 *      therefore carries a status — the destination (netcup) is `planned`, the
 *      vendors in use today are `transition` or `current`, and a row with no
 *      serving role says so. The notice is never false today and never needs a
 *      rewrite at cutover beyond flipping a row's status — a data edit, not a
 *      copy edit.
 *   2. **No claim without code.** A `current` retention row is enforced by code
 *      that exists today (`privacy-notice.test.ts` reads it); a `planned` row
 *      names the ticket that implements it in its `planRef` and is rendered as
 *      planned. The erasure path is the endpoint that exists, with the missing
 *      UI control stated as a gap — never an invented affordance.
 */

/**
 * When a vendor's row describes the processing. `current` is serving traffic
 * today, `transition` is in use today but narrowed or retired at the netcup
 * cutover, `planned` is the destination and is not in use yet, and
 * `no-serving-role` is a catalogued or bench-only vendor that carries no
 * serving traffic (personal data never reaches it in the live path).
 */
export type ProcessorStatus = "current" | "transition" | "planned" | "no-serving-role";

/** The register's Tier column: a compliance field, not a cost note. */
export type ProcessorTier = "paid" | "free";

/** The register's personal-data verdict for the row's tier. */
export type ProcessorVerdict = "permitted" | "not-for-personal-data";

export type SubProcessor = {
  id: string;
  /** The vendor's registered name — a legal/brand name, never translated. */
  name: string;
  status: ProcessorStatus;
  /** The register's Role column. */
  role: Localized;
  /** The register's "Personal data seen" column. */
  personalData: Localized;
  tier: ProcessorTier;
  verdict: ProcessorVerdict;
  /** A register caveat that must travel with the row (e.g. the free-tier rule). */
  note?: Localized;
};

/**
 * The sub-processor register (ADR-0043 decision 3), in register order. netcup
 * GmbH is the chosen production host; the migration that makes its row
 * `current` is #181.
 */
export const SUB_PROCESSORS: readonly SubProcessor[] = [
  {
    id: "netcup",
    name: "netcup GmbH",
    status: "planned",
    role: {
      id: "Penyedia VPS (Jerman/UE): reverse proxy, proses API, Postgres + pgvector, cadangan basis data.",
      en: "VPS host (Germany/EU): reverse proxy, the API process, Postgres + pgvector, database backups.",
    },
    personalData: {
      id: "Semuanya — hash token sesi, pertanyaan dan jawaban obrolan, trace yang tersimpan, masukan termasuk teks bebas opsional, IP di log akses, dan cadangan terenkripsi.",
      en: "All of it — session token hashes, chat questions and answers, persisted traces, feedback including optional free text, IPs in access logs, and encrypted backups.",
    },
    tier: "paid",
    verdict: "permitted",
    note: {
      id: "Perjanjian pemrosesan data (DPA, Art. 28(3)) wajib dan disimpulkan sebelum data pribadi apa pun masuk ke mesin ini.",
      en: "The data processing agreement (DPA, Art. 28(3)) is mandatory and is concluded before any personal data lands on the box.",
    },
  },
  {
    id: "cloudflare",
    name: "Cloudflare, Inc.",
    status: "transition",
    role: {
      id: "Transisi: runtime Workers, aset statis, R2 (korpus mentah + arsip snapshot), Durable Objects (pembatas laju), DNS. Setelah cutover: DNS, opsional proxy CDN.",
      en: "Transition: Workers runtime, static assets, R2 (raw corpus + snapshot archives), Durable Objects (rate limiter), DNS. Post-cutover: DNS, optionally the CDN proxy.",
    },
    personalData: {
      id: "IP (CF-Connecting-IP, log tepi), isi obrolan saat transit, arsip snapshot/cadangan setelah basis data pindah.",
      en: "IPs (CF-Connecting-IP, edge logs), chat content in flight, snapshot/backup archives once the database moves.",
    },
    tier: "free",
    verdict: "permitted",
    note: {
      id: "Baris ini menyempit menjadi DNS/proxy saat cutover.",
      en: "This row narrows to DNS/proxy at cutover.",
    },
  },
  {
    id: "neon",
    name: "Neon, Inc.",
    status: "transition",
    role: {
      id: "Transisi: Postgres terkelola + pgvector — seluruh skema produk.",
      en: "Transition: managed Postgres + pgvector — the whole product schema.",
    },
    personalData: {
      id: "Segala isi basis data, termasuk sesi, obrolan dan pesannya, trace jawaban, dan masukan.",
      en: "Everything in the database, including sessions, chats and their messages, answer traces, and feedback.",
    },
    tier: "free",
    verdict: "permitted",
    note: {
      id: "Hanya transisi; pensiunnya adalah #181. Risiko sisa tercatat: paket gratis bukan postur yang diutamakan register ini.",
      en: "Transitional only; retirement is #181. Recorded residual risk: a free plan is not the posture this register prefers.",
    },
  },
  {
    id: "gemini",
    name: "Google (Gemini API)",
    status: "current",
    role: {
      id: "LLM: router (peran murah), reviewer, embedding.",
      en: "LLM: router (cheap role), reviewer, embeddings.",
    },
    personalData: {
      id: "Isi prompt/embedding dari panggilan yang ditandai sebagai data pribadi.",
      en: "Prompt/embedding content of any call flagged personal.",
    },
    tier: "free",
    verdict: "not-for-personal-data",
    note: {
      id: "Tingkat gratis: lalu lintasnya dapat dipakai vendor untuk meningkatkan modelnya — karena itu data pribadi tidak boleh lewat sini.",
      en: "Free tier: its traffic may be used to improve the vendor's models — so personal data must not route through it.",
    },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    status: "current",
    role: {
      id: "LLM: generator — menerima pertanyaan dan konteks yang tersusun.",
      en: "LLM: generator — receives the question and the assembled context.",
    },
    personalData: {
      id: "Pertanyaan obrolan + konteks.",
      en: "Chat question + context.",
    },
    tier: "paid",
    verdict: "permitted",
  },
  {
    id: "alibaba",
    name: "Alibaba (Qwen / DashScope)",
    status: "no-serving-role",
    role: {
      id: "LLM: terjemahan saat ingest; kandidat generator yang terkatalog (kuncinya belum disediakan).",
      en: "LLM: ingestion translation; catalogued generator challenger (key not provisioned).",
    },
    personalData: {
      id: "Teks korpus saja dalam praktiknya.",
      en: "Corpus text only in practice.",
    },
    tier: "paid",
    verdict: "permitted",
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    status: "no-serving-role",
    role: {
      id: "LLM: kandidat yang terkatalog, tanpa peran melayani.",
      en: "LLM: catalogued challenger, no serving role.",
    },
    personalData: {
      id: "Tidak ada dalam layanan.",
      en: "None in serving.",
    },
    tier: "paid",
    verdict: "permitted",
  },
  {
    id: "typesafe",
    name: "TypeSafe AI",
    status: "no-serving-role",
    role: {
      id: "Model keputusan, hanya untuk bench sampai gerbang ADR-0042 diadopsi untuk layanan.",
      en: "Decision model, bench-only until the ADR-0042 gate is adopted for serving.",
    },
    personalData: {
      id: "Teks fixture gerbang saja.",
      en: "Gate fixture text only.",
    },
    tier: "paid",
    verdict: "permitted",
  },
];

/** The register rule the notice states above the table (ADR-0043 decision 3). */
export const REGISTER_RULE: Localized = {
  id: "Aturan register: data pribadi tidak pernah lewat tingkat gratis sebuah vendor — ketentuan tingkat gratis dapat mengizinkan masukannya dipakai di luar penyediaan layanan. Sebuah vendor hanya boleh membawa data pribadi pada ketentuan berbayar dengan perjanjian pemrosesan. Kolom tingkat dan putusan di bawah adalah kolom kepatuhan, bukan catatan biaya.",
  en: "The register's rule: personal data never rides a vendor's free tier — a free tier's terms may permit using the input beyond providing the service. A vendor may carry personal data only on paid terms under a processing agreement. The tier and verdict columns below are compliance fields, not cost notes.",
};

/** Where the register stands today, stated rather than implied (#181 pending). */
export const REGISTER_TRANSITION_NOTE: Localized = {
  id: "Layanan ini hari ini berjalan pada baris bertanda Transisi; pemindahan ke hosting Uni Eropa (netcup, Jerman) sedang berjalan. Baris bertanda Direncanakan adalah tujuan yang belum dipakai.",
  en: "The service runs today on the rows marked Transition; the move to EU hosting (netcup, Germany) is in progress. Rows marked Planned are the destination, not yet in use.",
};

/** The notice's own provenance, so a reader can check it against the register. */
export const REGISTER_SOURCE: Localized = {
  id: "Dirender dari register sub-prosesor di ADR-0043 — register yang sama yang menjadi dasar catatan Art. 30 (docs/GDPR-ARTICLE-30-RECORD.md).",
  en: "Rendered from the sub-processor register in ADR-0043 — the same register the Art. 30 record derives from (docs/GDPR-ARTICLE-30-RECORD.md).",
};

/** `current` is code that exists today; `planned` names its ticket in `planRef`. */
export type RetentionStatus = "current" | "planned";

export type RetentionItem = {
  id: string;
  status: RetentionStatus;
  /** What is kept. */
  what: Localized;
  /** The window, or the trigger that ends it. */
  window: Localized;
  /** In plain language, what enforces it — the code or config behind the claim. */
  enforcedBy: Localized;
  /** The registered ticket that implements a `planned` row (never on a `current` one). */
  planRef?: string;
};

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
    status: "planned",
    planRef: "#180",
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
    status: "planned",
    planRef: "#180",
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
    status: "planned",
    planRef: "#181",
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

/**
 * The erasure path the notice points at. `uiAffordance` records whether a
 * control in the interface reaches it: it is `absent` today, and the copy says
 * so instead of implying a button that does not exist (#179's recorded gap).
 */
export const ERASURE = {
  method: "DELETE",
  path: "/v1/auth/me",
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
} as const;

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
} as const;
