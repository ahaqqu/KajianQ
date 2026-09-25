import type { Localized } from "./localized";
import type { SubProcessor } from "./privacy-notice-types";

/**
 * The sub-processor register the `/about` notice renders: **ADR-0043 decision
 * 3 in data format**, and nothing else. Each row carries a status so the
 * notice is never false — netcup is `current` as the chosen production host
 * (#181 moved the serving path onto it, ADR-0044), the vendors the move
 * narrows are `transition`, and a bench-only vendor says so. A further cutover
 * is a status edit, not a copy rewrite.
 *
 * The Tier and Verdict columns are compliance fields, not cost notes: a tier
 * change re-opens the row's verdict (ADR-0043 decision 3), and
 * `models.json`'s `freeTier`/`personalDataAllowed` is this table's
 * machine-checkable shadow.
 *
 * **Status here states the target end state this PR lands, and the notice's
 * own wording carries the sequencing.** The serving path runs on the VPS
 * because that is what this PR builds and what the deploy path ships; the
 * owner's on-host application step is what made the box actually serve, and it
 * is **executed** — `docs/VPS-CUTOVER-RECORD.md` records it, and that record's
 * acceptance-criteria checklist is what closes #181's remaining criteria.
 * Flipping a status was not the migration: the migration is the code plus that
 * owner-executed step.
 */

/**
 * The sub-processor register (ADR-0043 decision 3), in register order. netcup
 * GmbH is the production host the serving path moved onto (#181, ADR-0044).
 */
export const SUB_PROCESSORS: readonly SubProcessor[] = [
  {
    id: "netcup",
    name: "netcup GmbH",
    status: "current",
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
      id: "Perjanjian pemrosesan data (DPA, Art. 28(3)) wajib dan telah disimpulkan sebelum data pribadi masuk ke mesin ini.",
      en: "The data processing agreement (DPA, Art. 28(3)) is mandatory and was concluded before any personal data lands on the box.",
    },
  },
  {
    id: "cloudflare",
    name: "Cloudflare, Inc.",
    status: "no-serving-role",
    role: {
      id: "Arsip at-rest saja: R2 menyimpan ekspor korpus mentah dan dump snapshot (arsip provenance). Runtime Workers, aset statis, dan Durable Objects sudah dihapus — tidak ada lalu lintas layanan yang lewat Cloudflare.",
      en: "At-rest archives only: R2 holds the raw-corpus exports and the snapshot dumps (the provenance archive). The Workers runtime, static assets, and Durable Objects are deleted; no serving traffic transits Cloudflare.",
    },
    personalData: {
      id: "Arsip snapshot dan ekspor korpus mentah saat disimpan (tidak ada data pribadi jalur layanan).",
      en: "Snapshot archives and raw-corpus exports at rest (no serving-path personal data).",
    },
    tier: "free",
    verdict: "permitted",
    note: {
      id: "Arsip provenance disimpan (ADR-0038: tidak ada yang satu-satunya salinan aset berbayar dihapus); tidak ada pemrosesan data pribadi saat runtime.",
      en: "The provenance archive is retained (ADR-0038: nothing that is the only copy of a paid asset is deleted); no runtime personal-data processing remains.",
    },
  },
  {
    id: "neon",
    name: "Neon, Inc.",
    status: "no-serving-role",
    role: {
      id: "Dekomisioning (proyek dihapus setelah arsip pasca-cutover terverifikasi di dua tempat); basis data berjalan sendiri di VPS dan vendor ini tidak punya peran tersisa.",
      en: "Decommissioned (the project was deleted after the post-cutover archive verified in two places); the database is self-hosted on the VPS and this vendor has no remaining role.",
    },
    personalData: {
      id: "Tidak ada — tidak ada data pribadi yang diproses di sini lagi.",
      en: "None — no personal data is processed here anymore.",
    },
    tier: "free",
    verdict: "permitted",
    note: {
      id: "Baris dipertahankan untuk riwayat register: vendor memproses data pribadi selama masa transisi hingga 2026-09-21.",
      en: "The row is kept for the register's history: the vendor processed personal data during the transition, until 2026-09-21.",
    },
  },
  {
    id: "gemini",
    name: "Google (Gemini API)",
    status: "current",
    role: {
      // Not the reviewer: ADR-0044's 2026-09-21 amendment re-headed the reviewer
      // to DeepSeek, and this free-tier row's verdict is not-for-personal-data —
      // so it cannot serve a reviewer call (every serving call site sets
      // PromptSpec.personalData). It is a fallback candidate on the cheap role
      // and serves embeddings for non-personal calls only.
      id: "LLM: kandidat cadangan pada peran murah (kepala rantai dilayani DeepSeek) dan embedding untuk panggilan non-pribadi saja.",
      en: "LLM: fallback candidate on the cheap role (DeepSeek heads the chain) and embeddings for non-personal calls only.",
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
    id: "gemini-paid",
    name: "Google (Gemini API, paid)",
    status: "current",
    role: {
      // Keyed separately from the free-tier row above because the register rule
      // keys on TERMS, not on the model: the same API and the same model id on
      // standard/paid terms may carry personal data, the free tier may not. The
      // serving retriever embeds the user's sub-queries, so the embedder role
      // rides this row (#181, ADR-0043's recorded gap closure).
      id: "LLM: peran embedder — meng-embed sub-kueri pengguna saat pencarian.",
      en: "LLM: the embedder role — embeds the user's sub-queries at retrieval time.",
    },
    personalData: {
      id: "Sub-kueri pengguna yang di-embed oleh retriever saat melayani.",
      en: "The user's sub-queries, embedded by the serving retriever.",
    },
    tier: "paid",
    verdict: "permitted",
    note: {
      id: "Ketentuan berbayar/standar dengan DPA — inilah yang membuat data pribadi boleh lewat sini, bukan tingkat gratisnya (ADR-0009, aturan register).",
      en: "Paid/standard terms with a DPA — that is what makes personal data permissible here, not the free tier (ADR-0009, the register rule).",
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

/** Where the register stands, stated rather than implied (#181). */
export const REGISTER_TRANSITION_NOTE: Localized = {
  id: "Layanan ini berjalan pada hosting Uni Eropa (netcup, Jerman) — baris yang ditandai Dipakai Hari Ini. Baris bertanda Transisi adalah vendor yang sedang disempitkan atau dipensiunkan oleh pemindahan ini dan akan hilang setelah pemilik menyetujui decommissioning.",
  en: "The service runs on EU hosting (netcup, Germany) — the row marked In use today. Rows marked Transition are the vendors this move narrows or retires, and disappear once the owner approves decommissioning.",
};

/** The notice's own provenance, so a reader can check it against the register. */
export const REGISTER_SOURCE: Localized = {
  id: "Dirender dari register sub-prosesor di ADR-0043 — register yang sama yang menjadi dasar catatan Art. 30 (docs/GDPR-ARTICLE-30-RECORD.md).",
  en: "Rendered from the sub-processor register in ADR-0043 — the same register the Art. 30 record derives from (docs/GDPR-ARTICLE-30-RECORD.md).",
};
