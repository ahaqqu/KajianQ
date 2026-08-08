> ⚠️ **SUPERSEDED by `kajianq-dars-spec.md` v2.0 (2026-08-08).** Retained for history. Still-valid details: §5 schema shape, §9 prompt library. Superseded: Python/FastAPI (now TypeScript via template fork), Cohere embedding (now `gemini-embedding-001`), Claude 3.5 (retired; vendor allowlist ADR-0005), Vercel/Railway hosting (now Workers + Neon, ADR-0004), cost table §11 (corrected in v2 §5).

# Spec & Arsitektur: Islamic Classical Knowledge RAG

> **Versi:** 1.2  
> **Tanggal:** 2026-08-08  
> **Target:** Chatbot RAG untuk Quran (teks Arab Uthmani), Hadith (Arab), dan kitab klasik Islam pra-600 H (bahasa asli penulis: mayoritas Arab, sebagian Persia).  
> **Bahasa Chat:** Indonesia & Inggris (query masuk dalam dua bahasa ini, retrieval dari corpus Arab/Indonesia/Inggris).  
> **Infrastruktur:** 100% API & managed cloud. Tidak ada GPU on-premise.

---

## 1. Visi & Differentiasi

### 1.1 Masalah yang Dipecahkan
- Chatbot Islam yang ada umumnya fokus Quran + Hadith Shahih (Bukhari & Muslim) saja.
- Jarang yang menyentuh **kitab fikih, aqidah, tasawuf, dan sejarah pra-600 H** secara mendalam.
- Citation sering tidak ketat — tidak menyebut juz, halaman, atau tingkat keabsahan hadith.
- Tidak ada transparansi madzhab atau perbedaan pendapat ulama klasik.
- **RAG naif kehilangan konteks umum** — prinsip besar Islam (kemudahan, rahmat, tidak membebani) tersebar di banyak kitab dan tidak selalu ikut ter-retrieve saat user bertanya detail fikih.
- **Data kitab klasik berantakan** — OCR Shamela sering corrupt, header/footer bercampur, pengarang salah. Developer yang tidak paham Arab sulit validasi manual.

### 1.2 Differentiasi (Moat)
| Fitur | Pasar Umum | Proyek Ini |
|-------|------------|------------|
| **Sumber** | Quran + Bukhari/Muslim | **+ Kitab pra-600 H** (Mudawwanah, Al-Umm, Ihya, Tabari, Syarh Aqidah Thahawiyah, dll) |
| **Bahasa Korpus** | Terjemahan modern | **Teks asli Arab** + terjemahan klasik (jika ada) |
| **Bahasa Chat** | English/Arabic | **Indonesia + Inggris** |
| **Citation** | Sebagian ada | **Ketat: Surat:Ayat, HR. Kitab No. (Grade), Kitab:Jilid:Halaman:Bab** |
| **Madzhab** | Tidak transparan | **User bisa filter/query per madzhab** (Hanafi, Maliki, Syafi'i, Hambali) |
| **Sanad** | Tidak ada | **Metadata sanad/tingkat hadith** tersedia untuk verifikasi |
| **Smart Router** | Klasifikasi sederhana | **Multi-hop reasoning + principle-aware retrieval** |
| **Data Quality** | Raw import | **LLM-validated cleaning pipeline** untuk teks Arab |

---

## 2. Arsitektur High-Level

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER INTERFACE                                  │
│         (Next.js / Streamlit — Chat UI bilingual ID/EN)                     │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SMART ROUTER LAYER                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  STAGE 1: INTENT & PRINCIPLE DETECTION                               │   │
│  │  (Claude Haiku / Qwen2.5-7B API)                                     │   │
│  │  Output: category, madzhab, needs_principle, principle_tags,         │   │
│  │          query_type, confidence, reasoning                           │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                  │                                           │
│                                  ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  STAGE 2: QUERY DECOMPOSITION (Multi-Hop)                            │   │
│  │  Output: Array sub-queries (factual + principle + dalil + hadith)    │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                  │                                           │
│                                  ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  STAGE 3: SOURCE ROUTING & RETRIEVAL STRATEGY                        │   │
│  │  Tentukan index mana yang di-query + metadata filter                 │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          RETRIEVAL LAYER                                     │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  HYBRID SEARCH: Dense (pgvector) + Sparse (BM25) + RRF Re-ranking  │   │
│  │                                                                      │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌───────────────────────────┐   │   │
│  │  │  quran      │  │  hadith     │  │  kitab_klasik             │   │   │
│  │  │  (child)    │  │  (child)    │  │  (child)                  │   │   │
│  │  │  + parent   │  │  + parent   │  │  + parent                 │   │   │
│  │  │  + tafsir   │  │  + sanad    │  │  + metadata madzhab       │   │   │
│  │  └─────────────┘  └─────────────┘  └───────────────────────────┘   │   │
│  │                                                                      │   │
│  │  ┌─────────────────────────────────────────────────────────────┐    │   │
│  │  │  PRINCIPLE INDEX                                            │    │   │
│  │  │  (prinsip umum: yusr, rahmah, masyaqqah, dharar, ...)       │    │   │
│  │  └─────────────────────────────────────────────────────────────┘    │   │
│  │                                                                      │   │
│  │  Index: HNSW (vector_cosine_ops) + BM25 Full-Text (tsvector)       │   │
│  │  Fusion: Reciprocal Rank Fusion (RRF) untuk gabungkan skor         │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         GENERATION LAYER                                     │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  CONTEXT ASSEMBLER                                                   │   │
│  │  Priority: Principle → Quran → Hadith (Sahih>Hasan) → Kitab → Tafsir │   │
│  │  Format: Markdown dengan citation block + parent context             │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                  │                                           │
│                                  ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  LLM API (Claude 3.5 Sonnet / Gemini 1.5 Pro / Qwen2.5-Max)        │   │
│  │  System Prompt: Strict grounding + Citation rules + No fatwa         │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                  │                                           │
│                                  ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  POST-PROCESSOR                                                      │   │
│  │  - Citation validator                                                │   │
│  │  - Principle consistency check                                       │   │
│  │  - Disclaimer + Response formatting (Arabic + ID/EN)                 │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 LLM Data Cleaning Pipeline (Ingestion)

```
Raw Data (Shamela .bok / OCR / PDF / JSON)
    ↓
[Script] Ekstrak teks mentah
    ↓
[LLM Haiku] Step 1: Arabic Text Cleaning
    "Bersihkan teks Arab berikut. Hapus nomor halaman, header, footer,
     perbaiki kata terputus, normalisasi hamza & ta marbuta."
    ↓
[LLM Haiku] Step 2: Metadata Extraction
    "Ekstrak: judul kitab, pengarang, nama bab (باب), nomor halaman,
     jenis teks (متن asli vs شرح komentar)."
    Output JSON.
    ↓
[LLM Haiku] Step 3: Principle Tagging
    "Tag dengan prinsip Islam: [yusr, rahmah, masyaqqah, dharar, ...]"
    ↓
[LLM Haiku] Step 4: Cross-Reference Validation (Hadith only)
    "Cek konsistensi periwayatan. Tandai 'suspect' jika anomali."
    ↓
[Script] Insert ke PostgreSQL
[API] Generate embedding (Cohere) — "Arab || Indonesia"
[Script] Update embedding column
```

---

## 3. Smart Router: Strategi Lengkap

Router dalam sistem ini bukan sekadar klasifikasi kategori. Router adalah **orkestrator retrieval** yang memutuskan:
1. **Apa** yang harus dicari
2. **Di mana** harus mencari
3. **Seberapa luas** konteks yang dibutuhkan

### 3.1 Stage 1: Intent & Principle Detection

**Input:** User query (bilingual ID/EN)  
**Output:** JSON dengan analisis mendalam

```json
{
  "category": "fikih",
  "subcategory": "ibadah",
  "madzhab": "syafii",
  "needs_principle": true,
  "principle_tags": ["yusr", "rahmah"],
  "query_type": "analogy",
  "confidence": 0.92,
  "reasoning": "User bertanya tentang shalat (fikih/ibadah) dengan nuansa 'kenapa tidak boleh sulit'. Ini menunjukkan butuh prinsip kemudahan (yusr) dan rahmat (rahmah)."
}
```

**Kategori `query_type`:**
| Tipe | Definisi | Contoh | Strategi Retrieval |
|------|----------|--------|-------------------|
| **factual** | Fakta langsung dari sumber | "Berapa rakaat shalat maghrib?" | Quran/Hadith index saja |
| **ruling** | Hukum spesifik | "Hukum shalat orang sakit?" | Kitab fikih + Hadith + Principle (yusr) |
| **analogy** | Butuh prinsip umum untuk memahami detail | "Kenapa shalat tidak boleh terlalu sulit?" | **Principle index wajib** + Kitab + Hadith |
| **comparison** | Perbandingan antar madzhab | "Beda pendapat Imam Malik dan Syafi'i tentang wudhu?" | Kitab index dengan filter madzhab |
| **history** | Konteks sejarah | "Kapan shalat lima waktu diwajibkan?" | Sejarah index + Hadith |
| **aqidah** | Keyakinan | "Sifat Allah dalam ayat Kursi?" | Quran + Aqidah index |

**Principle Tags yang Dideteksi:**
| Tag | Prinsip | Sumber Kunci |
|-----|---------|--------------|
| `yusr` | Kemudahan dalam agama | QS. 2:185, 2:286; HR. Bukhari 39 |
| `rahmah` | Islam sebagai rahmat | QS. 21:107 |
| `masyaqqah` | Kesulitan membawa kemudahan | Prinsip ushul fikih |
| `dharar` | Madharat dihapuskan | Prinsip ushul fikih |
| `umum_balwa` | Kesulitan umum memaafkan | Prinsip ushul fikih |
| `istihsan` | Keutamaan hati nurani | Prinsip ushul fikih (Hanafi) |
| `sad_zari` | Menutup jalan ke arah keburukan | Prinsip ushul fikih |

### 3.2 Stage 2: Query Decomposition (Multi-Hop)

**Input:** Original query + intent JSON  
**Output:** Array sub-queries untuk retrieve paralel

**Contoh Decomposition:**

```
Original: "Kenapa sholat tidak boleh terlalu sulit?"

Sub-query 1 (factual): "hukum shalat orang sakit menurut madzhab syafii"
Sub-query 2 (principle): "prinsip kemudahan dalam ibadah Islam yusr"
Sub-query 3 (dalil): "Allah tidak membebani hamba melebihi kemampuan dalil"
Sub-query 4 (hadith): "hadith agama ini mudah tidak menyulitkan"
```

**Aturan Decomposition:**
- Selalu generate **1 sub-query faktual** (detail hukum)
- Jika `needs_principle=true`, generate **1 sub-query principle**
- Jika kategori `fikih`, generate **1 sub-query dalil Qurani**
- Jika kategori `hadith`, generate **1 sub-query sanad verification**

### 3.3 Stage 3: Source Routing

Berdasarkan intent, router memutuskan **kombinasi index** yang di-query:

| Intent | Index yang Di-query | Priority |
|--------|---------------------|----------|
| Factual Quran | `quran_child` + `quran_parent` | Quran saja |
| Factual Hadith | `hadith_child` + `hadith_parent` | Hadith Sahih > Hasan |
| Ruling Fikih | `kitab_child` + `hadith_child` + `principle` | Kitab madzhab > Hadith > Principle |
| Analogy | `principle` + `kitab_child` + `hadith_child` + `quran_child` | **Principle dulu**, baru detail |
| Comparison | `kitab_child` (madzhab A) + `kitab_child` (madzhab B) | Parallel retrieve |
| History | `kitab_child` (sejarah) + `hadith_child` | Sejarah > Hadith |

**Metadata Filter yang Diterapkan:**
```sql
-- Contoh: Ruling Fikih Syafi'i
WHERE source_type = 'kitab' 
  AND madzhab = 'syafii'
  AND category = 'fikih'

-- Contoh: Hadith hanya Sahih
WHERE source_type = 'hadith'
  AND grade IN ('Sahih', 'Mutawatir')

-- Contoh: Principle retrieval
WHERE source_type = 'principle'
  AND principle_tag = ANY('{yusr, rahmah}')
```

### 3.4 Stage 4: Context Assembly & Priority Scoring

Setelah retrieve dari multi-source, context di-sort berdasarkan **hierarchy keilmuan Islam**:

```
Layer 1: PRINCIPLES (jika needs_principle=true)
         → Prinsip umum yang menjadi "lensa"

Layer 2: QURAN
         → Ayat-ayat yang di-retrieve (dengan tafsir ringkas)

Layer 3: HADITH
         → Hadith (prioritas: Mutawatir > Sahih > Hasan)
         → Jika Dhaif: tampilkan dengan peringatan

Layer 4: KITAB KLASIK
         → Detail fikih/aqidah dari kitab pra-600 H
         → Dengan parent context (bab lengkap)

Layer 5: CONCEPT LINKS (jika ada)
         → Dokumen terkait dari tabel concept_links
```

**Relevance Scoring (RRF Hybrid):**
```
dense_rank   = vector_search(query_embedding, top_k=100)   -- pgvector
sparse_rank  = bm25_search(query_text, top_k=100)         -- PostgreSQL FTS

final_score(doc) = Σ 1/(k + rank) untuk setiap ranking
                   k = 60 (konstanta RRF)

hierarchy_bonus:
  - Quran: +0.3
  - Hadith Sahih: +0.25
  - Hadith Hasan: +0.15
  - Kitab: +0.1
  - Principle: +0.2 (jika query_type=analogy)
```

---

## 4. Sumber Dataset

### 4.1 Quran (Teks Arab Uthmani + Metadata)

| Sumber | URL | Format | Lisensi |
|--------|-----|--------|---------|
| **Tanzil** | https://tanzil.net/download/ | TXT, XML, JSON | Bebas (public domain teks) |
| **Quran.com API** | https://api.quran.com | JSON | Open untuk non-komersial |
| **The Quran App Dataset** | https://github.com/The-Quran-Project/The-Quran-App/tree/main/dataset | JSON | Open source |

**Yang didownload:**
- Teks Uthmani per ayat (Arab)
- Metadata: nomor surah, ayah, juz, hizb, rubu, page_madinah
- Terjemahan Indonesia (Kemenag) & English (Sahih International)
- Tafsir per ayat: Ibnu Katsir, Al-Jalalayn

### 4.2 Hadith (Teks Arab + Metadata)

| Sumber | URL | Format | Catatan |
|--------|-----|--------|---------|
| **hadith-json** (GitHub — AhmedBaset) | https://github.com/AhmedBaset/hadith-json | JSON | **50.884 hadith** dari 17 kitab. Arabic + English. |
| **HuggingFace — meeAtif/hadith_datasets** | https://huggingface.co/datasets/meeAtif/hadith_datasets | JSON, CSV | 6 kitab utama. Arabic + English + grading. |
| **Sanadset** | https://www.kaggle.com/datasets/fahd09/hadith-narrators-dataset | CSV | **650K hadith** dengan sanad & matn di-tag. |
| **Sunnah.com API** | https://sunnah.com | JSON (API) | 20+ koleksi. Butuh API key via GitHub issue. |

**Yang didownload:**
- Matn hadith dalam bahasa Arab asli
- Metadata: kitab, bab, nomor hadith, tingkat (Sahih/Hasan/Dhaif), periwayat
- Terjemahan English/Indonesia (jika tersedia)

### 4.3 Kitab Klasik Pra-600 H (Bahasa Asli Penulis)

| Sumber | URL | Format | Catatan |
|--------|-----|--------|---------|
| **Al-Maktaba al-Shamela** | https://shamela.ws | `.bok` (MS Access MDB) | **17.000–29.000 buku**. Corpus teks Islam terbesar. |
| **Shamela Mirror** | https://archive.org/details/MaktabaShamelaWin10.7z | `.7z` | Mirror Internet Archive. |
| **Shamela Parser (Node.js)** | https://github.com/ragaeeb/shamela | TypeScript | Library parse dan ekstrak teks. |
| **OpenITI** | https://openiti.org | TEI XML | Corpus akademik teks Islam. |

**Kitab Prioritas Pra-600 H:**

| Kitab | Pengarang | Wafat | Bidang | Madzhab |
|-------|-----------|-------|--------|---------|
| Al-Mudawwanah al-Kubra | Sahnun | 240 H | Fikih | Maliki |
| Al-Umm | Imam Syafi'i | 204 H | Fikih | Syafi'i |
| Syarh Aqidah Thahawiyah | Imam Thahawi | 321 H | Aqidah | Hanafi |
| Ihya Ulumuddin | Imam Ghazali | 505 H | Tasawuf | Syafi'i |
| Tarikh ar-Rusul wa al-Muluk | Imam Tabari | 310 H | Sejarah | — |
| Al-Kamil fi at-Tarikh | Ibn Atsir | 630 H | Sejarah | — |
| Al-Muwatha' | Imam Malik | 179 H | Hadith/Fikih | Maliki |
| Musnad Imam Ahmad | Imam Ahmad | 241 H | Hadith | Hambali |
| Sunan ad-Darimi | Imam Darimi | 255 H | Hadith | — |
| Tahdzib al-Akhlaq | Ibn Miskawayh | 421 H | Akhlak | — |

**Catatan Penting:**
- Format `.bok` = file MS Access (`.mdb`) yang di-rename.
- Bisa diparse dengan `pyodbc` / `mdb-tools` atau library `ragaeeb/shamela`.
- Banyak kitab di Shamela adalah edisi modern atau syarh ulama abad 7–10 H. Verifikasi tahun asli matn.
- Teks Arab asli kitab pra-600 H umumnya domain publik.

### 4.4 Tafsir

| Sumber | URL | Format |
|--------|-----|--------|
| **Tanzil Tafsir** | https://tanzil.net/download/ | XML/JSON |
| **Quran.com Tafsir API** | https://api.quran.com | JSON |
| **Altafsir.com** | https://altafsir.com | Web (scraping manual) |

**Tafsir Prioritas:**
- Tafsir Ibnu Katsir
- Tafsir Al-Jalalayn
- Tafsir At-Tabari (Jami' al-Bayan)

### 4.5 Principle Index (Buat Sendiri)

Principle Index tidak tersedia sebagai dataset siap pakai. Harus dibangun manual dari:
1. **Ayat-ayat prinsip** di Quran (extract dari Tanzil)
2. **Hadith-hadith prinsip** (extract dari hadith-json)
3. **Kaidah ushul fikih** (input manual dari kitab Ushul Fikih klasik)

**Contoh Entry Principle Index:**
```json
{
  "principle_tag": "yusr",
  "principle_name_ar": "اليسر",
  "principle_name_id": "Kemudahan",
  "principle_name_en": "Ease",
  "description_id": "Islam memberi kemudahan, tidak menyulitkan",
  "source_quran": ["2:185", "2:286"],
  "source_hadith": ["bukhari:39"],
  "source_kitab": ["Al-Umm:Kitab Shalat:Bab Rukhsah"],
  "application": ["shalat orang sakit", "puasa orang sakit", "tayammum"]
}
```

---

## 5. Skema Database (PostgreSQL + pgvector)

### 5.1 Tabel Parents (Konteks Umum / Bab / Surah)

```sql
CREATE TABLE doc_parents (
    id SERIAL PRIMARY KEY,
    source_type VARCHAR(50) NOT NULL,       -- 'quran', 'hadith', 'kitab', 'principle'
    source_collection VARCHAR(100),         -- 'Sahih Bukhari', 'Al-Umm'
    title VARCHAR(300),                     -- 'Bab Rukhsah dalam Ibadah'
    title_ar VARCHAR(300),                  -- Judul asli Arab
    content TEXT,                           -- Isi bab/surah/prinsip lengkap
    summary TEXT,                           -- Ringkasan oleh LLM Haiku
    summary_id TEXT,                        -- Ringkasan bahasa Indonesia
    embedding VECTOR(1024),                 -- Embed dari summary, bukan full text
    metadata JSONB                          -- Flexible metadata
);

CREATE INDEX idx_doc_parents_embedding ON doc_parents 
USING hnsw (embedding vector_cosine_ops);
```

### 5.2 Tabel Children (Detail / Ayat / Hadith / Paragraf)

```sql
CREATE TABLE doc_children (
    id BIGSERIAL PRIMARY KEY,
    parent_id INTEGER REFERENCES doc_parents(id),

    -- Klasifikasi sumber
    source_type VARCHAR(50) NOT NULL,       -- 'quran', 'hadith', 'kitab', 'tafsir'
    source_collection VARCHAR(100),         -- 'Sahih Bukhari', 'Tafsir Ibnu Katsir'

    -- Referensi spesifik
    reference VARCHAR(200),                 -- 'QS. Al-Baqarah:255' atau 'HR. Bukhari no.573'
    book_name VARCHAR(200),                 -- 'Kitab Shalat', 'Juz 3'
    chapter VARCHAR(300),                   -- 'Bab Wudhu', 'Surah Al-Baqarah'
    page_number VARCHAR(50),                -- Untuk kitab klasik
    volume_number VARCHAR(50),              -- Jilid kitab

    -- Metadata keilmuan
    grade VARCHAR(20),                      -- 'Sahih', 'Hasan', 'Dhaif', 'Mutawatir'
    madzhab VARCHAR(50),                    -- 'Hanafi', 'Maliki', 'Syafii', 'Hambali', 'General'
    narrator_chain TEXT,                    -- Sanad hadith
    related_ayah INTEGER[],                 -- Array ayat terkait
    principle_tags VARCHAR(50)[],           -- ['yusr', 'rahmah'] — untuk principle linking

    -- Konten multibahasa (DUAL STRATEGY)
    text_raw TEXT,                          -- Teks mentah dari sumber (Shamela/OCR)
    text_cleaned_ar TEXT,                   -- Setelah LLM cleaning
    text_indonesia TEXT,                    -- Terjemahan Indonesia
    text_english TEXT,                      -- Terjemahan English

    -- Embedding (DUAL: Arab + Indonesia concatenated)
    -- Embed dari: "text_cleaned_ar || text_indonesia"
    embedding VECTOR(1024),

    -- LLM Validation Tracking
    llm_validation_status VARCHAR(20) DEFAULT 'pending',
    llm_validation_notes TEXT,
    extracted_metadata JSONB,               -- Hasil ekstraksi LLM: pengarang, bab, dll

    -- Teknis
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Index HNSW untuk similarity search
CREATE INDEX idx_doc_children_embedding ON doc_children 
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Index untuk filtering metadata (kritis untuk router)
CREATE INDEX idx_children_source_type ON doc_children(source_type);
CREATE INDEX idx_children_grade ON doc_children(grade);
CREATE INDEX idx_children_madzhab ON doc_children(madzhab);
CREATE INDEX idx_children_collection ON doc_children(source_collection);
CREATE INDEX idx_children_principle_tags ON doc_children USING gin(principle_tags);

-- Full-text search (BM25 via tsvector)
CREATE INDEX idx_children_arabic_fts ON doc_children 
USING gin(to_tsvector('arabic', COALESCE(text_cleaned_ar, text_raw)));

CREATE INDEX idx_children_indonesia_fts ON doc_children 
USING gin(to_tsvector('indonesian', text_indonesia));

CREATE INDEX idx_children_english_fts ON doc_children 
USING gin(to_tsvector('english', text_english));
```

### 5.3 Tabel Principle Index

```sql
CREATE TABLE principle_index (
    id SERIAL PRIMARY KEY,
    principle_tag VARCHAR(50) UNIQUE NOT NULL,    -- 'yusr', 'rahmah', 'dharar'
    principle_name_ar VARCHAR(100),
    principle_name_id VARCHAR(100),
    principle_name_en VARCHAR(100),
    description_id TEXT,
    description_en TEXT,
    source_quran VARCHAR(20)[],                   -- ['2:185', '2:286']
    source_hadith VARCHAR(50)[],                  -- ['bukhari:39']
    source_kitab VARCHAR(200)[],                  -- ['Al-Umm:Kitab Shalat:Bab Rukhsah']
    application_domains VARCHAR(50)[],            -- ['fikih', 'ibadah', 'muamalah']
    embedding VECTOR(1024),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_principle_embedding ON principle_index 
USING hnsw (embedding vector_cosine_ops);
```

### 5.4 Tabel Concept Links (Pseudo-Graph)

```sql
CREATE TABLE concept_links (
    id SERIAL PRIMARY KEY,
    from_doc_id INTEGER REFERENCES doc_children(id),
    to_doc_id INTEGER REFERENCES doc_children(id),
    relation_type VARCHAR(50),              -- 'explains', 'contradicts', 'analogous', 'principle_of', 'references'
    description TEXT,
    strength FLOAT DEFAULT 1.0,             -- 0.0 - 1.0, confidence relasi
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_concept_from ON concept_links(from_doc_id);
CREATE INDEX idx_concept_to ON concept_links(to_doc_id);
CREATE INDEX idx_concept_relation ON concept_links(relation_type);
```

### 5.5 Tabel Chat History

```sql
CREATE TABLE chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(100),
    language_preference VARCHAR(10) DEFAULT 'id',
    madzhab_preference VARCHAR(50),         -- User bisa set preferensi madzhab
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE chat_messages (
    id BIGSERIAL PRIMARY KEY,
    session_id UUID REFERENCES chat_sessions(id),
    role VARCHAR(20) NOT NULL,              -- 'user', 'assistant', 'system'
    content TEXT NOT NULL,
    intent JSONB,                           -- Simpan hasil router untuk analisis
    sources JSONB,                          -- Array citation yang digunakan
    created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 6. Pipeline Data (Data Ingestion)

### 6.1 Quran
```
Tanzil (TXT/XML) 
  → Parse per ayat 
  → Insert PARENT: per Surah (isi surah lengkap)
  → Insert CHILD: per Ayat (text_arabic, metadata surah/ayah/juz/page)
  → Fetch tafsir per ayat 
  → Concatenate "Arab || Indonesia" 
  → Embed dengan Cohere multilingual
  → Update embedding
```

### 6.2 Hadith
```
hadith-json (JSON) 
  → Parse per hadith 
  → Insert PARENT: per Bab (kumpulkan semua hadith dalam bab)
  → Insert CHILD: per Hadith (matn_arabic, book, chapter, number, grade, narrator)
  → [LLM Haiku] Tag principle_tags (auto-detect dari keyword matn)
  → Concatenate "Arab || Indonesia" 
  → Embed dengan Cohere
  → Update embedding
```

### 6.3 Kitab Klasik (Paling Kompleks — dengan LLM Cleaning)
```
Shamela (.bok files) 
  → Rename .bok → .mdb 
  → Parse dengan Python (pyodbc / mdb-tools) atau Node.js (shamela lib) 
  → Filter: hanya kitab pra-600 H 
  → [LLM Haiku] Step 1: Clean text_raw → text_cleaned_ar
      "Bersihkan teks Arab. Hapus header/footer/nomor halaman."
  → [LLM Haiku] Step 2: Extract metadata (pengarang, bab, jenis teks)
  → [LLM Haiku] Step 3: Tag principle_tags
  → Hierarchical chunking:
      PARENT: Bab / Fasal lengkap → [LLM Haiku] Generate summary + summary_id
      CHILD:  Paragraf (200-500 token, jangan potong kalimat/sanad)
  → Concatenate "text_cleaned_ar || text_indonesia" 
  → Embed dengan Cohere
  → Insert ke doc_parents + doc_children
```

### 6.4 Principle Index (Manual / Semi-Auto)
```
Extract ayat prinsip dari Quran (manual list QS)
  → Extract hadith prinsip dari hadith-json (filter by keyword)
  → Input kaidah ushul fikih (manual dari kitab Ushul)
  → Insert ke principle_index
  → Embed description_id + description_en + principle_name_ar
  → Build concept_links (auto: link principle → related ayat/hadith/kitab)
```

---

## 7. Stack Teknis

| Layer | Teknologi | Alasan |
|-------|-----------|--------|
| **Vector DB** | PostgreSQL + pgvector (Supabase / Neon) | Gratis tier tersedia, SQL native, metadata filtering kuat, cukup untuk <1M vector |
| **Embedding API** | Cohere `embed-multilingual-v3` | Arabic-Indonesia-English terbaik, 1024 dimensi, harga kompetitif |
| **LLM Router** | Claude 3.5 Haiku API | Murah ($0.80/1M input), cepat, cukup untuk JSON classification |
| **LLM Query Expansion** | Claude 3.5 Haiku API | Murah, cukup untuk dekomposisi query |
| **LLM Data Cleaning** | Claude 3.5 Haiku API | Murah, cukup untuk cleaning Arab + ekstraksi metadata |
| **LLM Generator** | Claude 3.5 Sonnet API | Patuh instruksi terbaik, citation akurat, context 200K |
| **Alternative LLM** | Gemini 1.5 Pro API | Context 1-2M, cocok kalau retrieve chunk panjang |
| **Alternative LLM** | Qwen2.5-Max API | Murah, Arabic/Indonesia sangat kuat |
| **Backend** | Python (FastAPI) | Ringan, async, mudah integrasi PostgreSQL |
| **Frontend** | Next.js / Streamlit | Next.js untuk produksi, Streamlit untuk prototype |
| **Hosting** | Vercel (frontend) + Railway/Render (backend) | Murah, managed, tanpa GPU |
| **OCR (opsional)** | PaddleOCR Arabic / Tesseract | Kalau ada PDF scan kitab klasik |

---

## 8. Plan Implementasi (Phased)

### Phase 0: Foundation (Minggu 1)
- [ ] Daftar akun: Supabase, Cohere, Anthropic
- [ ] Download dataset: Tanzil Quran, hadith-json
- [ ] Setup PostgreSQL + pgvector di Supabase
- [ ] Buat tabel: doc_parents, doc_children, principle_index, concept_links, chat_sessions, chat_messages

### Phase 1: Quran + Hadith MVP (Minggu 2–3)
- [ ] Parse & insert Quran (parent=Surah, child=Ayat)
- [ ] Parse & insert Hadith (parent=Bab, child=Hadith)
- [ ] Build embedding pipeline (Cohere API — concatenate Arab+Indonesia)
- [ ] Build Smart Router Stage 1 (intent detection)
- [ ] Build retrieval endpoint (vector + metadata filter)
- [ ] Build chat endpoint dengan Claude 3.5 Sonnet
- [ ] System prompt dengan citation rules
- [ ] UI chat sederhana (Streamlit)

**Deliverable:** Chatbot yang bisa jawab pertanyaan Quran & Hadith dengan citation.

### Phase 2: Smart Router + Principle Index (Minggu 4–5)
- [ ] Build Principle Index (input manual 10-20 prinsip utama)
- [ ] Build Smart Router Stage 2 (query decomposition)
- [ ] Build Smart Router Stage 3 (source routing)
- [ ] Build Context Assembler (priority: principle → quran → hadith → kitab)
- [ ] Implement Hybrid Search (Dense + BM25 + RRF)
- [ ] Test dengan query analogy ("Kenapa shalat tidak boleh sulit?")

**Deliverable:** Chatbot bisa jawab dengan prinsip umum + detail fikih.

### Phase 3: Kitab Klasik Pra-600 H + LLM Cleaning (Minggu 6–8)
- [ ] Download Shamela Standard (4 GB)
- [ ] Eksplorasi metadata, filter kitab pra-600 H
- [ ] Script ekstraksi .bok → teks mentah
- [ ] **LLM Cleaning Pipeline:** Haiku untuk clean + metadata extract + principle tag
- [ ] Hierarchical chunking kitab klasik (parent=bab, child=paragraf)
- [ ] Insert kitab klasik ke PostgreSQL
- [ ] Build concept_links (auto-link principle → kitab)
- [ ] Update router untuk kategori "Kitab Fikih", "Kitab Aqidah"

**Deliverable:** Chatbot bisa jawab dari kitab klasik dengan citation halaman/bab.

### Phase 4: Polish & Scale (Minggu 9–10)
- [ ] Hybrid retrieval tuning (RRF parameter optimization)
- [ ] Re-ranker (cross-encoder API atau LLM-based scoring)
- [ ] Chat history & context awareness
- [ ] UI bilingual (Indonesia/English toggle)
- [ ] Safety layer: hadith grade checker, contradiction flagger
- [ ] Load testing & optimasi query

**Deliverable:** Production-ready chatbot.

---

## 9. Strategi Prompting

### 9.1 Smart Router: Intent Detection Prompt

```
Kamu adalah router cerdas untuk sistem pengetahuan Islam klasik.
Analisis query user dan output dalam format JSON.

Aturan:
1. category: quran | hadith | fikih | aqidah | tasawuf | sejarah | general
2. madzhab: hanafi | maliki | syafii | hambali | null (jika tidak disebutkan)
3. needs_principle: true jika query mengandung nuansa analogi, filosofis, atau "kenapa"
4. principle_tags: pilih dari [yusr, rahmah, masyaqqah, dharar, umum_balwa, istihsan, sad_zari]
5. query_type: factual | ruling | analogy | comparison | history | aqidah

Contoh:
Query: "Kenapa sholat tidak boleh terlalu sulit?"
Output:
{
  "category": "fikih",
  "subcategory": "ibadah",
  "madzhab": null,
  "needs_principle": true,
  "principle_tags": ["yusr", "rahmah"],
  "query_type": "analogy",
  "confidence": 0.95,
  "reasoning": "User bertanya tentang shalat dengan nuansa 'kenapa tidak boleh sulit'. Butuh prinsip kemudahan (yusr) dan rahmat (rahmah)."
}

Query: {user_query}
Output:
```

### 9.2 Smart Router: Query Decomposition Prompt

```
Kamu adalah decomposer query untuk sistem pengetahuan Islam.
Pecah query user menjadi 2-4 sub-query yang bisa di-retrieve secara paralel.

Aturan:
1. Selalu buat 1 sub-query faktual (detail hukum/teks)
2. Jika needs_principle=true, buat 1 sub-query prinsip
3. Jika kategori=fikih, buat 1 sub-query dalil Qurani
4. Jika kategori=hadith, buat 1 sub-query verifikasi sanad

Format output: JSON array string.

Contoh:
Query: "Kenapa sholat tidak boleh terlalu sulit?"
Intent: {"category":"fikih","needs_principle":true,"principle_tags":["yusr"]}

Output:
[
  "hukum shalat orang sakit menurut madzhab syafii",
  "prinsip kemudahan dalam ibadah Islam yusr",
  "dalil Allah tidak membebani hamba melebihi kemampuan",
  "hadith agama ini mudah tidak menyulitkan"
]
```

### 9.3 LLM Data Cleaning: Arabic Text Cleaner Prompt

```
Kamu adalah editor teks Arab klasik. Bersihkan teks berikut dari noise format.

Tugas:
1. Hapus nomor halaman, header, footer, dan metadata cetakan
2. Perbaiki kata yang terputus di akhir baris (kata yang diikuti tanda -)
3. Normalisasi hamza (أ، إ، آ → ا di awal kata jika bukan nama)
4. Normalisasi ta marbutah (ة → ه di akhir kata jika konteks bahasa)
5. Hapus spasi ganda dan baris kosong berlebihan
6. Jangan ubah isi teks asli, hanya bersihkan format

Output hanya teks bersih, tanpa penjelasan.

Teks:
{text_raw}
```

### 9.4 LLM Data Cleaning: Metadata Extractor Prompt

```
Ekstrak metadata dari teks kitab klasik berikut.

Tugas:
1. Identifikasi judul kitab (jika ada di header)
2. Identifikasi nama pengarang (jika ada)
3. Identifikasi nama bab (باب) atau fasal (فصل)
4. Identifikasi nomor halaman (jika ada)
5. Tentukan apakah ini teks asli (متن) atau komentar/syarah (شرح)

Output dalam format JSON:
{
  "kitab_title": "...",
  "author": "...",
  "bab_name": "...",
  "page_number": "...",
  "text_type": "matn|sharh|unknown"
}

Teks:
{text_cleaned_ar}
```

### 9.5 LLM Generator: System Prompt

```
Kamu adalah asisten pengetahuan Islam klasik. Aturan mutlak:

1. JAWAB HANYA berdasarkan dokumen yang diberikan dalam context.
2. Jika dokumen tidak cukup, jawab: "Maaf, saya belum menemukan dalil yang cukup 
   untuk pertanyaan ini dalam sumber yang tersedia."
3. Jangan pernah berfatwa atau memberikan pendapat pribadi.
4. Prioritas sumber: Quran → Hadith Mutawatir/Sahih → Hadith Hasan → Tafsir → Kitab Fikih/Aqidah.
5. Setiap kutipan WAJIB mencantumkan sumber:
   - Quran: QS. [Nama Surah]:[Ayat]
   - Hadith: HR. [Kitab] no. [Nomor] ([Grade])
   - Kitab: [Nama Kitab], [Pengarang], Jilid [X], Hal. [Y], Bab [Z]
6. Jika ada perbedaan pendapat antar madzhab, sebutkan semua dengan netral.
7. Jika hadith dhaif, beri peringatan: "Hadith ini dinilai dhaif oleh para ulama."
8. Bahasa jawaban: sesuaikan dengan bahasa pertanyaan user (Indonesia atau English).
9. Sertakan teks Arab asli untuk ayat dan hadith yang dikutip.
10. Jika context menyertakan prinsip umum (kemudahan, rahmat), gunakan sebagai 
    "lensa" untuk menjelaskan detail fikih. Jangan biarkan jawaban terdengar kering/teknis.
11. Akhiri dengan disclaimer: "Untuk fatwa spesifik, silakan konsultasi ulama setempat."
```

---

## 10. Safety & Quality Control

| Layer | Mekanisme |
|-------|-----------|
| **Source Grounding** | LLM hanya boleh kutip dari context yang diberikan. Prompt eksplisit. |
| **Citation Validator** | Post-process: cek apakah ayat/hadith yang dikutip benar ada di retrieved chunks. |
| **Hadith Grade Flag** | Kalau grade='Dhaif' atau tidak ada, tampilkan peringatan. |
| **Contradiction Handler** | Kalau retrieve 2 sumber bertentangan (beda madzhab), sebutkan keduanya. |
| **Principle Consistency** | Cek apakah jawaban selaras dengan prinsip umum yang di-retrieve. |
| **Toxic/Bias Filter** | Hindari jawaban yang menyerang madzhab/organisasi tertentu. |
| **Disclaimer** | Selalu akhiri dengan disclaimer fatwa. |

---

## 11. Estimasi Biaya (API-Only, per 1.000 query)

| Komponen | Biaya per 1K query | Keterangan |
|----------|-------------------|------------|
| **Embedding** (Cohere) | ~$0.15 | 20 chunk × 1K query = 20K embeddings |
| **LLM Router** (Claude Haiku) | ~$0.30 | Intent detection + query decomposition |
| **LLM Generator** (Claude Sonnet) | ~$2.50 | Context panjang (~80K token dengan principle+parent) |
| **PostgreSQL** (Supabase) | $0 (gratis tier) | Sampai 500MB–1GB |
| **Hosting** (Vercel + Render) | $0–$7/bulan | Tier gratis cukup untuk MVP |
| **Total per 1K query** | **~$2.95** | Bisa turun dengan caching & query optimization |

### Biaya One-Time: LLM Data Cleaning (Kitab Klasik)

| Tahap | Token per Kitab | Biaya per Kitab (Haiku) |
|-------|-----------------|------------------------|
| Text Cleaning | ~100K-300K | ~$0.10-0.30 |
| Metadata Extraction | ~50K-100K | ~$0.05-0.10 |
| Principle Tagging | ~50K-100K | ~$0.05-0.10 |
| **Total per Kitab** | | **~$0.20-0.50** |
| **10 Kitab** | | **~$2-5 total** |

Sangat murah dibanding data berantakan di production.

---

## 12. Risiko & Mitigasi

| Risiko | Mitigasi |
|--------|----------|
| **OCR/ekstraksi kitab Shamela tidak bersih** | LLM Haiku cleaning pipeline + manual sampling 100 chunk |
| **Halusinasi LLM mengarang ayat/hadith** | Strict prompt + citation validator + hanya jawab dari retrieved context |
| **Terjemahan tafsir berhak cipta** | Untuk MVP, gunakan terjemahan public domain atau buat terjemahan sendiri |
| **Kitab pra-600 H sulit diverifikasi tahun** | Cross-check dengan OpenITI metadata dan ensiklopedi ulama klasik |
| **Principle Index tidak lengkap** | Mulai dengan 10-20 prinsip utama, expand secara iteratif |
| **Query Arabic → retrieve dokumen Arab** | Cohere multilingual embedding menangani cross-lingual; test dengan benchmark |
| **Biaya API tinggi untuk query panjang** | Cache embedding, gunakan Haiku untuk router, optimasi context window |
| **LLM cleaning salah interpretasi teks Arab** | Simpan `text_raw` sebagai backup; review sampling manual via translator |

---

## 13. Appendix: Daftar Kitab Prioritas untuk Phase 3

| # | Kitab | Pengarang | Wafat | Bidang | Status |
|---|-------|-----------|-------|--------|--------|
| 1 | Al-Mudawwanah al-Kubra | Sahnun | 240 H | Fikih | ⭐ Prioritas |
| 2 | Al-Umm | Imam Syafi'i | 204 H | Fikih | ⭐ Prioritas |
| 3 | Syarh Aqidah Thahawiyah | Imam Thahawi | 321 H | Aqidah | ⭐ Prioritas |
| 4 | Ihya Ulumuddin | Imam Ghazali | 505 H | Tasawuf | ⭐ Prioritas |
| 5 | Tarikh ath-Thabari | Imam Tabari | 310 H | Sejarah | ⭐ Prioritas |
| 6 | Al-Kamil fi at-Tarikh | Ibn Atsir | 630 H | Sejarah | ⭐ Prioritas |
| 7 | Al-Muwatha' | Imam Malik | 179 H | Hadith/Fikih | ⭐ Prioritas |
| 8 | Musnad Imam Ahmad | Imam Ahmad | 241 H | Hadith | ⭐ Prioritas |
| 9 | Sunan ad-Darimi | Imam Darimi | 255 H | Hadith | ⭐ Prioritas |
| 10 | Tahdzib al-Akhlaq | Ibn Miskawayh | 421 H | Akhlak | ⭐ Prioritas |
| 11 | Al-Mabsut (bagian) | Imam Sarakhsi | 483 H | Fikih | Medium |
| 12 | Al-Hidayah | Al-Marghinani | 593 H | Fikih | Medium |

---

*Dokumen ini adalah living document. Update seiring progress development.*
