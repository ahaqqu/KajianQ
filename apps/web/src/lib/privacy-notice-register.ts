import type { Localized } from "./localized";
import type { SubProcessor } from "./privacy-notice-types";

/**
 * The sub-processor register the `/about` notice renders: the Art. 30 record's register (§8) in
 * data format, and nothing else. ADR-0043 decision 3 records the rule those rows enforce. Each
 * row carries a status so the notice is never false: netcup is
 * `current` as the production host, the vendors the move narrows are `transition`, and a row
 * with no serving role says so. A further cutover is a status edit, not a copy rewrite.
 *
 * The Tier and Verdict columns are compliance fields, not cost notes: a tier change re-opens
 * the row's verdict, and `models.json`'s `freeTier`/`personalDataAllowed` is this table's
 * machine-checkable shadow.
 */

/**
 * The sub-processor register in register order: netcup GmbH heads it as the production host.
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
    id: "openrouter",
    name: "OpenRouter",
    status: "current",
    role: {
      // The serving aggregator (ADR-0069): one paid, DPA-covered row carries every
      // chat serving role, the embedder, and the decision seam (schema-constrained
      // structured output). The direct Gemini and DeepSeek rows retired with it.
      id: "LLM: peran generator, reviewer, dan murah (router); embedding peran embedder saat pencarian; model keputusan untuk pratinjau sitasi dan pemingkatan ulang hasil pencarian.",
      en: "LLM: the generator, reviewer and cheap (router) roles; the embedder role's embeddings at retrieval time; the decision model behind the citation pre-gate and the retrieval rerank.",
    },
    personalData: {
      id: "Pertanyaan obrolan + konteks yang tersusun; sub-kueri pengguna yang di-embed; klaim dari jawaban dan petikan bukti saat pratinjau sitasi berjalan.",
      en: "Chat question + assembled context; the user's embedded sub-queries; claim spans and cited passages while the citation screen runs.",
    },
    tier: "paid",
    verdict: "permitted",
    note: {
      id: "Ketentuan berbayar (kredit prabayar) dengan DPA OpenRouter yang dipublikasikan (GDPR/CCPA) — diterima pemilik sebagai bagian dari penyiapan akun sebelum kunci produksi diikat (ADR-0069). OpenRouter bertindak sebagai agregator dan meneruskan panggilan ke penyedia model hulu di bawah rantai sub-prosesornya sendiri; mode nol-retensi tersedia pada akun.",
      en: "Paid terms (prepaid credits) under OpenRouter's published DPA (GDPR/CCPA) — accepted by the owner as part of the account setup, before the production key binds (ADR-0069). OpenRouter acts as an aggregator and forwards calls to upstream model providers under its own sub-processor chain; a zero-retention mode is available on the account.",
    },
  },
  {
    id: "ollama-cloud",
    name: "Ollama",
    status: "current",
    role: {
      // The switchable row: selected only by the `ollama` provider profile. The default
      // chains (and the rollback) head the same roles through OpenRouter, so the row
      // states the condition rather than claiming unconditional traffic.
      id: "LLM: vendor obrolan yang dapat dipilih — rantai generator, reviewer, reviewer-live, dan murah saat profil penyedia `ollama` dipilih; profil default (dan rollback) melayani peran yang sama melalui OpenRouter.",
      en: "LLM: the switchable chat vendor — the generator, reviewer, reviewer-live and cheap chains when the `ollama` provider profile is selected; the default profile (and the rollback) serves those roles through OpenRouter.",
    },
    personalData: {
      id: "Pertanyaan obrolan + konteks yang tersusun; sub-kueri pengguna saat peran murah dilayani.",
      en: "Chat question + assembled context; the user's sub-queries when the cheap role is served.",
    },
    tier: "paid",
    verdict: "permitted",
    note: {
      id: "Ketentuan nol-retensi, tidak pernah dicatat, dan tidak untuk pelatihan — **tidak ada DPA yang ditandatangani di berkas**. Pemilik menerima basis itu (ADR-0059); ini bukan klaim DPA. Hanya aktif bila profil `ollama` dipilih.",
      en: "Zero-retention, never-logged, never-trained terms — **no signed DPA is on file**. The owner accepted that basis (ADR-0059); this is not a DPA claim. Only active when the `ollama` profile is selected.",
    },
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
];

/** The register rule the notice states above the table (ADR-0043 decision 3, with
 * the recorded exception of ADR-0059). */
export const REGISTER_RULE: Localized = {
  id: "Aturan register: data pribadi tidak pernah lewat tingkat gratis sebuah vendor — ketentuan tingkat gratis dapat mengizinkan masukannya dipakai di luar penyediaan layanan. Sebuah vendor membawa data pribadi pada ketentuan berbayar dengan perjanjian pemrosesan, kecuali satu pengecualian yang tercatat: Ollama Cloud pada ketentuan nol-retensi/tanpa-pelatihan, tanpa DPA di berkas, yang diterima pemilik (ADR-0059). Kolom tingkat dan putusan di bawah adalah kolom kepatuhan, bukan catatan biaya.",
  en: "The register's rule: personal data never rides a vendor's free tier — a free tier's terms may permit using the input beyond providing the service. A vendor carries personal data on paid terms under a processing agreement, except for one recorded exception: Ollama Cloud on its zero-retention/no-training terms, with no DPA on file, accepted by the owner (ADR-0059). The tier and verdict columns below are compliance fields, not cost notes.",
};

/** Where the register stands, stated rather than implied. */
export const REGISTER_TRANSITION_NOTE: Localized = {
  id: "Layanan ini berjalan pada hosting Uni Eropa (netcup, Jerman) — baris yang ditandai Dipakai Hari Ini. Baris bertanda Transisi adalah vendor yang sedang disempitkan atau dipensiunkan oleh pemindahan ini dan akan hilang setelah pemilik menyetujui decommissioning.",
  en: "The service runs on EU hosting (netcup, Germany) — the row marked In use today. Rows marked Transition are the vendors this move narrows or retires, and disappear once the owner approves decommissioning.",
};

/** The notice's own provenance, so a reader can check it against the register. */
export const REGISTER_SOURCE: Localized = {
  id: "Dirender dari register sub-prosesor pada catatan Art. 30 (docs/GDPR-ARTICLE-30-RECORD.md) — aturan yang ditegakkannya tercatat di ADR-0043 keputusan 3.",
  en: "Rendered from the sub-processor register in the Art. 30 record (docs/GDPR-ARTICLE-30-RECORD.md) — the rule it enforces is recorded in ADR-0043 decision 3.",
};
