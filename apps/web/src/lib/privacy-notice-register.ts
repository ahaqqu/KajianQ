import type { Localized } from "./localized";
import type { SubProcessor } from "./privacy-notice-types";

/**
 * The sub-processor register the `/about` notice renders: **ADR-0043 decision
 * 3 in data form**, and nothing else. Each row carries a status so the notice
 * is never false today — the netcup destination is `planned` (the migration is
 * #181), the vendors serving today are `transition` or `current`, and a
 * bench-only vendor says so. Cutover is a status edit, not a copy rewrite.
 *
 * The Tier and Verdict columns are compliance fields, not cost notes: a tier
 * change re-opens the row's verdict (ADR-0043 decision 3), and
 * `models.json`'s `freeTier`/`personalDataAllowed` is this table's
 * machine-checkable shadow.
 */

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
