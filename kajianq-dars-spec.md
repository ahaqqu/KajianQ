# KajianQ & DARS — Specification, Architecture & Plan

> **Version:** 2.0 (2026-08-08) — supersedes `islamic_classical_rag_spec.md` v1.2
> **Status:** Grilled & approved via grill-with-docs session; decisions recorded in `adr/0005–0009`, vocabulary in `CONTEXT.md`
> **Doc language:** English (technical) — UI copy is Indonesian-first (en/id externalized)

---

## 1. Vision & Objectives

### 1.1 What this is

- **KajianQ** — an open-source (MIT) Islamic classical-knowledge chatbot for the **general Indonesian Muslim public** (not scholars), chatting in **Indonesian and English** over a corpus of **original Arabic sources**: Quran (Uthmani), hadith (with sanad & grades), and **pre-600 H kitab** (fiqh, aqidah, tasawuf, history).
- **DARS** (*Dynamic Automated RAG Solution*; evokes Arabic *dars*, "lesson") — the generic, domain-agnostic RAG engine underneath: ingestion, Smart Router, retrieval, generation, evaluation. Engine code contains **no Islamic-domain logic**; KajianQ is a domain pack + apps on top.

Both live in **one monorepo** (ADR-0005): DARS as workspace packages under `packages/`, KajianQ under `apps/`. Reusability (public-service chat, internal-company knowledge) is a stated long-term goal, enforced by package boundaries — not by building a platform prematurely.

### 1.2 Long-term mission

Improve the Islamic character (*akhlak*) of Indonesian Muslims — youth in particular — by making it easy to get answers grounded in classical Islamic sources. The v1 product serves the **general public**; the youth mission is served through accessibility (plain Indonesian, mobile-first PWA), not by narrowing the audience.

### 1.3 Success for v1

**Real public users at small scale.** The product is deployed, open-source, and used by real people. Success = users receive trustworthy, strictly-sourced answers, and the system visibly improves through user feedback. This justifies the traceability, feedback, and evaluation infrastructure being in scope for v1.

### 1.4 Differentiators (moat)

| Feature | Typical market | KajianQ |
|---|---|---|
| Sources | Quran + Bukhari/Muslim | + pre-600 H kitab (Mudawwanah, Al-Umm, Ihya, Tabari, …) |
| Corpus language | Modern translations | Original Arabic + labeled machine translation |
| Chat language | English/Arabic-first | **Indonesian-first** + English |
| Citations | Partial | Strict: QS Surah:Ayah · HR Book No. (Grade) · Kitab, Author, Vol:Page:Bab |
| Madzhab | Opaque | Filter/compare; Syafi'i-weighted with transparent gaps |
| Reasoning | Naive RAG | Principle-aware: general maxims retrieved alongside rulings |
| Transparency | Black box | **Full user-facing Trace** of how each answer was built |
| Data quality | Raw import | LLM-cleaned, LLM-translated, harness-validated |

### 1.5 Hard boundaries (never cross)

1. **Never issue personal fatwa.** The system presents what classical sources say, with citations, and always ends with: *"Untuk fatwa spesifik, silakan konsultasi ulama setempat."*
2. **Never answer beyond the retrieved context.** If retrieval is insufficient, say so explicitly.
3. **Never hide the machinery.** Every answer carries its full Trace (ADR-0007).
4. **Never silently machine-translate.** All kitab translations are labeled *"Terjemahan mesin — lihat teks Arab asli"* with the Arabic always shown (ADR-0006).
5. **Dhaif hadith is always flagged** with a warning.

---

## 2. Product Specification

### 2.1 Capabilities

- **Bilingual chat (ID/EN)** with automatic language detection; answers in the user's language; Arabic originals shown for every quoted ayah/hadith/kitab passage.
- **Strict citations** — Quran: `QS. Al-Baqarah:255`; Hadith: `HR. Bukhari no. 573 (Sahih)`; Kitab: `Al-Umm, Imam Syafi'i, Jilid 1, Hal. 102, Bab …`.
- **Madzhab policy (Syafi'i-weighted, transparent gaps).** Corpus ingests all madhhabs available. When the user does not specify: lead with the Syafi'i view (Indonesian majority), note other madzhab views *if the corpus covers them*, otherwise state *"pendapat madzhab lain belum tersedia dalam korpus"*. Users may set a madzhab preference or explicitly compare madhhabs. Differences are presented neutrally — never attacking any school.
- **Hadith grade transparency.** Grades (`mutawatir | sahih | hasan | dhaif`) are always displayed; dhaif material carries a warning.
- **Principle-aware answers.** Why/analogy questions retrieve **Principles** (yusr, rahmah, masyaqqah, dharar, umum al-balwa, istihsan, sadd al-dhara'i, …) alongside specific rulings, so answers explain the *lens*, not just the rule.
- **Full Trace panel (user-facing).** Every answer expands to show: router intent, sub-queries, retrieved chunks with scores, model identity. General users see a readable "sources consulted" view first; technical details one tap deeper.
- **Trace-anchored feedback.** Thumbs up/down per answer, plus flagging a specific Trace element: *wrong citation · irrelevant chunk · bad machine translation · questionable grade*. Free-text optional. Anonymous (template's anonymous sessions), rate-limited. Feedback lands in the admin review queue; accepted items become **Golden Set** cases.
- **Chat history & context awareness** (Postgres-backed sessions).

### 2.2 Quality & safety policy (risk-tiered review)

Hallucination / inaccuracy / deviation from Islamic legal method is the **#1 stated risk**. Controls, in order of cost:

| Control | Coverage | Mechanism |
|---|---|---|
| Source grounding prompt | Always | Answer only from retrieved context; explicit refusal text |
| Citation validator | Always | Deterministic: every citation must exist in retrieved chunks |
| Grade flag | Always | Deterministic: dhaif/missing grade → warning |
| Contradiction handler | Always | Conflicting madzhab sources → present both neutrally |
| Faithfulness review (cross-vendor LLM) | ~10% live sample + **all** thumbs-down + full Golden Set pre-release | Gemini grades Qwen-generated answers (never same vendor) |
| Ingestion spot-check (cross-vendor LLM) | 5–10% of cleaned/translated chunks | Different vendor than the cleaner/translator |
| Principle consistency | Sampled | Answer must not contradict retrieved Principles |

**Authority order** (per *kaidah ushul*): Quran → Hadith (mutawatir > sahih > hasan; dhaif flagged) → Tafsir → Kitab. Principles are assembled *first in the prompt* as a lens (presentation order), while the system prompt enforces the Quran-first *authority* order — the two orderings are deliberately distinct.

### 2.3 UI notes

React PWA from the template (TanStack Router/Query, Tailwind), **tight card layouts without excessive whitespace** (user preference), mobile-first, en/id externalized strings (template guardrail), expandable Trace per message, feedback widget anchored to Trace elements.

---

## 3. Architecture

### 3.1 Monorepo (fork of `agentic-project-template`)

One GitHub repo, Bun workspaces, kept in sync with the upstream template via template-sync (`apps/`, `packages/`, `package.json`, `CONTEXT.md` are merge paths — project code lives there). ADRs live in root `adr/` per template convention.

```
apps/
  web/        # React PWA: KajianQ chat UI (+ admin routes, v1)     — from template shell
  api/        # Hono Worker: /v1/chat, /v1/feedback, /v1/admin/*    — from template shell
packages/
  contracts/  # Valibot contracts for all API boundaries            — template pattern
  infra/      # Logger, ConfigStore, RateLimiter, ObjectStore,      — template adapters
              # + RagStore (ADR-0008), + Provider adapters
  rag-core/   # DARS: pipeline interfaces — Router, Retriever,      — NEW, domain-agnostic
              # Assembler, Generator, Reviewer
  rag-ingest/ # DARS: source parsers (Tanzil, hadith-json, Shamela),— NEW, domain-agnostic
              # cleaning/translation pipeline, chunking
  eval/       # DARS: benchmark harness, Golden Set runner, judges  — NEW, domain-agnostic
  kajianq-domain/ # KajianQ: madzhab enums, principle seed data,    — NEW, the domain pack
              # prompts (ID/EN), citation formatters
scripts/      # Ingestion & eval CLI (Bun, run off-Workers)
```

**Dropped from template:** `packages/local-first` (no offline requirement — chat needs network anyway), D1 + Notes tracer feature. **Reused as-is:** Workers deploy pipeline, anonymous-session auth (matches anonymous feedback), Valibot contracts, adapters, i18n, Vitest/fast-check/Playwright-BDD, CI gates (size-limit, agentic-limits, truth).

**Stage communication:** in-process typed interfaces between packages (modular monolith) — no HTTP between pipeline stages. Per notes.md: simple and maintainable wins; extract a service only when a second consumer actually appears.

**Fork guardrail amendment (ADR-0009):** the template's "never add paid services to the critical path" is amended — paid LLM/embedding APIs *are* the critical path of a RAG product. Price must be weighed in every model decision; cost is traced per query; free tiers are used where quality allows.

### 3.2 Runtime topology (ADR-0008)

```
User → Cloudflare (Static Assets + Workers)
         apps/web (React PWA)
         apps/api (Hono)
            │  in-process: rag-core pipeline
            ▼
         Neon Postgres + pgvector   (RagStore adapter; vectors, metadata, chat, traces, feedback, golden set)
         Cloudflare R2              (ObjectStore adapter; raw Shamela exports, text_raw backups)
External APIs: Gemini / Qwen / DeepSeek / Kimi  (Provider interface; ADR-0009)
```

Ingestion and eval harness run as **Bun CLI scripts** (local/CI), never on Workers. Neon free tier covers small scale; backups managed. Deliberate deviation from the template's D1 — the Smart Router needs SQL metadata filtering + pgvector HNSW + tsvector, which D1/Vectorize cannot express.

### 3.3 The DARS pipeline (Smart Router)

1. **Intent & Principle detection** (cheap tier) → JSON: `category, subcategory, madzhab, needs_principle, principle_tags, query_type (factual|ruling|analogy|comparison|history|aqidah), confidence, reasoning`.
2. **Query decomposition** (cheap tier) → 2–4 sub-queries: always one factual; +principle if `needs_principle`; +Quranic dalil if fiqh; +sanad verification if hadith. +Arabic expansion terms from the Terminology Glossary for variant-term queries (ADR-0010; expansion only, never query translation).
3. **Source routing** (rules + cheap tier) → index selection + SQL metadata filters (`source_type`, `madzhab`, `grade IN …`, `principle_tags ANY …`).
4. **Retrieval** — hybrid: pgvector HNSW dense + tsvector sparse (upgrade to ParadeDB `pg_search` true BM25 if the Neon plan allows) fused with **RRF (k=60)** + hierarchy bonuses (Quran +0.3, Sahih +0.25, Hasan +0.15, Kitab +0.1, Principle +0.2 on analogy).
5. **Context assembly** — presentation order: Principles → Quran → Hadith → Kitab → concept links; parents contribute LLM summaries so children keep their chapter context.
6. **Generation** (quality tier) — strict grounding system prompt (v1.2 §9.5 rules carried over), streaming.
7. **Post-processing** — citation validator (deterministic), grade flags, disclaimer, ID/EN formatting; sampled faithfulness review enqueued.

### 3.4 Providers & default model mix (2026-08, ADR-0009)

All calls behind a **Provider interface** (`generate/stream/embed`); every stage's model is config-swappable. **Vendor allowlist: Gemini, Kimi, DeepSeek, Qwen only.** Tie-break: near-equal capability → prefer Qwen.

| Role | Default | Alt / challenger | Price (in/out per MTok) |
|---|---|---|---|
| Embedding | `gemini-embedding-001` (1536-dim MRL) | Qwen3-Embedding | free tier / low |
| Cheap tier (router stages 1–3, tagging, cleaning) | Gemini 3 Flash (free tier) | DeepSeek V4-Flash ($0.14/$0.28) | $0.50/$3 |
| Generator | **Qwen3.7-Max** (1M ctx, 119 langs) | Gemini 3.1 Pro, Kimi K3 | $2.50/$7.50 |
| Reviewer (cross-vendor) | Gemini 3.1 Pro (golden set), Gemini 3 Flash (live sample) | Kimi K2.6 | $2/$12, $0.50/$3 |
| Ingestion translation (AR→ID) | Qwen3 Max | Gemini 3 Flash | $0.78/$3.90 |

⚠️ **The embedding default is unproven on our corpus.** Phase 1's benchmark harness must validate Arabic+Indonesian cross-lingual recall on real KajianQ data before the chat build proceeds; the spec's former Cohere choice remains a one-line config fallback. Gemini free-tier traffic is used for training by Google — acceptable for public religious content and anonymous queries; never route feedback free-text containing personal data through free tiers.

The harness (notes.md: *"test LLM and give a score for Arabic & Indonesian ability"*) is `packages/eval`: versioned test sets (Arabic comprehension, Indonesian generation, citation discipline, translation fidelity), scoring every candidate; results stored and visible in admin; re-run on model releases.

### 3.5 Data layer

Carried over from v1.2 §5 with changes:

- `doc_parents`, `doc_children`, `principle_index`, `concept_links`, `chat_sessions`, `chat_messages` — unchanged in shape, **except `embedding VECTOR(1536)`** (Gemini MRL), and sparse search via `to_tsvector('arabic'|'indonesian'|'english', …)` (both are built-in PostgreSQL configs).
- **New:** `answer_traces` (message_id, router intent JSONB, sub_queries JSONB, chunks JSONB `[{id, rrf_score, rank_dense, rank_sparse}]`, model, tokens_in/out, cost_usd, latency_ms) — powers the user Trace panel and admin.
- **New:** `feedback` (message_id, rating, anchor_type `answer|chunk|citation|translation|grade`, anchor_id, category, free_text, status `pending|accepted|rejected`, created_at).
- **New:** `golden_questions`, `eval_runs`, `eval_results` — Golden Set + harness results.
- **New:** `model_configs` — registry of provider/model/role assignments (config files remain source of truth; table mirrors for admin display).

### 3.6 Admin (v1 scope)

Routes inside `apps/web` behind a single env-configured admin credential:

1. **Trace browser** — every message's full trace (tokens, cost, raw JSON beyond the user view).
2. **Feedback queue** — accept/reject; accepted → Golden Set.
3. **Harness results viewer** — benchmark/eval runs, trends, model comparisons (harness itself is CLI).

Prompt/model config stays in files, reviewed via PRs — no UI editing in v1.

### 3.7 Integration testing (real, per notes.md)

- **Golden Set**: ~50–100 ID/EN questions with expected source types, required citations, known traps (dhaif hadith, cross-madzhab differences, untranslated kitab, refusal cases).
- **Metrics**: retrieval recall, citation validity (deterministic), faithfulness (cross-vendor judge).
- **Cadence**: full suite gates every release + nightly; 5–10 query smoke per PR on free tier. Cost-capped; results in admin. Template's unit/property/BDD gates remain unchanged.

---

## 4. Data Strategy

### 4.1 Sources (unchanged from v1.2 §4, licensing duties noted)

| Corpus | Source | Format | Licensing duty |
|---|---|---|---|
| Quran (Uthmani + metadata) | Tanzil.net | TXT/XML/JSON | Public domain text; attribute |
| Terjemahan ID | Kemenag via Tanzil | TXT | **Verify terms**; attribute (risk §7) |
| Tafsir | Tanzil / Quran.com (Ibnu Katsir, Jalalayn, Tabari) | XML/JSON | Attribute; prefer public-domain editions |
| Hadith ~50K | hadith-json (AhmedBaset) | JSON | Check repo license; attribute |
| Hadith 650K w/ sanad | Sanadset (Kaggle) | CSV (later phase) | Check Kaggle terms; attribute |
| Hadith API | Sunnah.com | JSON API | **API key request needed** (open task) |
| Kitab | Shamela `.bok` / OpenITI TEI | MDB / XML | Classical texts public domain; attribute Shamela/OpenITI |

All attributions ship in `NOTICES/DATASETS.md` (MIT repo; notes.md requirement).

### 4.2 Priority kitab (pre-600 H) — unchanged

Mudawwanah (Sahnun 240H), Al-Umm (Syafi'i 204H), Syarh Aqidah Thahawiyah (321H), Ihya Ulumuddin (505H), Tarikh Tabari (310H), Al-Kamil (Ibn Athir 630H), Muwatta (179H), Musnad Ahmad (241H), Sunan ad-Darimi (255H), Tahdzib al-Akhlaq (421H); medium: Al-Mabsut (483H, partial), Al-Hidayah (593H). Verify matn dates against OpenITI metadata — many Shamela editions are later commentaries (matn vs sharh discipline per `CONTEXT.md`).

### 4.3 Principle Index

~10–20 entries, **LLM-drafted then verified by the user against Indonesian-language sources** (the core maxims are well documented in Indonesian ushul-fiqh literature; anchors like QS 2:185/2:286/21:107 and Bukhari 39 are checkable without Arabic literacy). Entry shape per v1.2 §4.5. Corpus auto-tagging stays LLM-based with sampled cross-vendor review.

### 4.4 Ingestion pipelines

- **Quran/Hadith:** parse → parent/child insert → LLM principle-tagging → embed (`text_ar || text_id`) → index. (v1.2 §6.1–6.2)
- **Kitab:** `.bok`→`.mdb` extraction script (Node `shamela` lib or `mdb-tools`) → clean (cheap tier) → metadata extract → principle tag → **translate to Indonesian (Qwen3 Max, labeled)** → hierarchical chunk (parent=bab + LLM summary; child=200–500-token paragraphs, never cut mid-sentence/sanad) → embed → insert. `text_raw` always preserved; originals archived to R2. (v1.2 §6.3 + ADR-0006)
- **Principle Index:** curated seed → embed → auto concept-links to anchored ayat/hadith/kitab.

---

## 5. Cost Model (corrected)

v1.2's "~$2.95 per 1K queries" was **internally inconsistent** (~80K-token contexts would alone cost >$100/1K queries). Realistic model, assuming assembled context ≈ 8–15K input tokens and ~600 output tokens per answer:

| Component | Per 1K queries | Notes |
|---|---|---|
| Embedding (query) | ~$0 | Gemini free tier |
| Router (3 cheap-tier calls) | ~$0–2 | Gemini 3 Flash free tier; Haiku-class fallback priced |
| **Generator — Qwen3.7-Max** | **$20–45** | 8K ctx ≈ $22; 15K ctx ≈ $42 |
| Generator — Qwen3 Max (alt) | $8–15 | near-parity → Qwen preferred anyway |
| Generator — DeepSeek V4-Pro (alt) | $5–10 | if harness shows sufficient citation discipline |
| Reviewer (10% sample) | ~$1 | Gemini 3 Flash |
| Neon + Cloudflare | $0 | free tiers at small scale |
| **Realistic total** | **~$10–45 / 1K queries** | generator choice swings 6× — this is what the harness is for |

Mitigations: top-k discipline (8–12 chunks, not 20), prompt caching for the stable system prompt + Principle blocks, context trimming, and per-query cost tracing in `answer_traces`.

**One-time ingestion (10 kitab):** translation ~$2.50–3/kitab (Qwen3 Max, incl. output tokens) + cleaning/tagging ~$0.30 (DeepSeek V4-Flash) + embeddings ~$0.10 → **~$30–40 total**. Cheap relative to the cost of dirty data in production.

---

## 6. Risks & Mitigations (updated)

| Risk | Mitigation |
|---|---|
| Hallucinated/invented citations | Deterministic citation validator; answer-only-from-context prompt; cross-vendor faithfulness sampling; Golden Set gate |
| Answer conflicts with Islamic legal method | Usul-derived authority order in prompt; Principle lens; contradiction handler; scholar-visible Traces invite correction |
| Gemini embedding underperforms Cohere on Arabic↔Indonesian | Phase 1 harness gate before chat build; Provider interface makes Cohere a config-level fallback |
| Machine translation of classical Arabic is wrong | Label + Arabic always shown (ADR-0006); sampled cross-vendor review; translation-fidelity suite in harness; `text_raw` preserved |
| Shamela OCR noise / wrong-author editions | LLM cleaning pipeline; matn/sharh discipline; OpenITI cross-check; 100-chunk manual sampling via translator |
| Kemenag translation licensing | Verify terms before launch; attribute in NOTICES; fallback to alternate ID translation |
| Vendor constraint limits quality ceiling | Harness tracks allowlist candidates per release; allowlist is policy (ADR-0009), revisitable by the owner |
| Free-tier data usage (Google trains on it) | Public content only; no personal data through free tiers; paid tier for sensitive flows |
| Cost overrun at scale | §5 mitigations; budget alerts; generator downgrade path proven by harness |
| Principle Index gaps | Start 10–20, expand iteratively from accepted feedback |

## 7. Plan (12 weeks, approved)

| Phase | Weeks | Deliverable (exit criteria) |
|---|---|---|
| **0. Fork & foundation** | 1 | Template forked; Notes/local-first/D1 removed; Neon + RagStore adapter live; 4 Provider impls behind interface; fork AGENTS.md amended (ADR-0009); NOTICES/DATASETS.md created; CONTEXT.md + ADRs imported |
| **1. Data & benchmarks** | 2–3 | Quran + hadith ingested & embedded; hybrid retrieval endpoint with metadata filters; **harness v1 passes: embedding recall + generator citation discipline validated on Arabic/ID test set** |
| **2. Chat MVP + transparency** | 4–5 | `/v1/chat` with citation validator; chat UI (ID/EN, tight cards); **user-facing Trace panel**; anonymous sessions; history |
| **3. Router + Principles + admin** | 6–7 | Full Smart Router; Principle Index (~15 curated); trace-anchored feedback; admin (traces, queue, harness results) → **PUBLIC BETA** |
| **4. Kitab ingestion** | 8–10 | Shamela extraction script; cleaning/translation pipeline; 10 priority kitab live with page/bab citations; concept links — informed by beta feedback |
| **5. Hardening & v1.0** | 11–12 | Golden Set release gate green; safety layers complete; caching/cost tuning; load test; docs; **v1.0 launch** |

**Operational open tasks:** create vendor accounts (Google AI Studio, Alibaba Cloud, DeepSeek, Moonshot); request Sunnah.com API key; verify Kemenag translation terms; confirm Neon plan extension support (`pgvector`, and `pg_search` if available).

## 8. Record of Decisions

| ADR | Decision |
|---|---|
| `adr/0005` | Monorepo: DARS engine packages + KajianQ product app |
| `adr/0006` | Kitab LLM-translated at ingestion, labeled, Arabic always shown |
| `adr/0007` | User-facing Trace + trace-anchored feedback |
| `adr/0008` | Neon Postgres+pgvector behind RagStore adapter (not D1/Vectorize) |
| `adr/0009` | Vendor allowlist (Gemini/Kimi/DeepSeek/Qwen); paid critical path accepted with price discipline; Qwen tie-break |
| `adr/0010` | Terminology Glossary + Arabic query expansion (never query translation) |
| `adr/0011` | Deep Think: iterative budget-capped retrieval mode, never read-all |

Domain vocabulary: `CONTEXT.md`. Workflow after this spec: `to-spec` → `to-tickets` per the template's agentic pipeline.

---

*Living document. Supersedes `islamic_classical_rag_spec.md` v1.2, which is retained for history (its §9 prompt library and §5 schema details remain valid where not amended here).*
