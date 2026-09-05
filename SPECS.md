# KajianQ & DARS — Specification, Architecture & Plan

> **Version:** 2.1 (2026-08-28) — living document; supersedes `INITIAL_IDEA.md` (v1.2; frozen, retained for history)
> **Status:** Grilled & approved via grill-with-docs session; decisions recorded in `adr/` (0005 onward, full index in §8), vocabulary in `CONTEXT.md`
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
6. **Never derive a new ruling.** The Generator surfaces classical reasoning (ta'lil, madzhab disagreement, applied Principles) *as cited*; it never synthesizes novel rulings, never resolves disagreements, never upgrades a grade. Insufficient evidence → refusal, not synthesis (ADR-0015).
7. **No corpus-wide inferred knowledge graphs.** Knowledge layers are bounded, curated, human-reviewed concept structures (#24 terminology graph, #29 isnad, Principle Index, curated `concept_links`) — never a community-GraphRAG corpus extraction (ADR-0016).

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
  infra/      # Logger, ConfigStore, ObjectStore,                  — template adapters
              # RagStore (ADR-0008), + Provider adapters
  rag-core/   # DARS: pipeline interfaces — Router, Retriever,      — NEW, domain-agnostic
              # Assembler, Generator, Reviewer
  rag-ingest/ # DARS: source parsers (Tanzil, hadith-json, Shamela),— NEW, domain-agnostic
              # cleaning/translation pipeline, chunking
  eval/       # DARS: benchmark harness, Golden Set runner, judges  — NEW, domain-agnostic
  rate/       # @app/rate: RateLimiter adapter (Durable Object +    — shared, project-agnostic
              # bounded-memory fallback)
  hardening/  # @app/hardening: security headers/CSP + ASSETS       — shared, project-agnostic
              # serving for the Hono Worker
  kajianq-domain/ # KajianQ: madzhab enums, principle seed data,    — NEW, the domain pack
              # prompts (ID/EN), citation formatters
scripts/      # Ingestion & eval CLI (Bun, run off-Workers)
```

**Dropped from template:** `packages/local-first` (no offline requirement — chat needs network anyway), D1 + Notes tracer feature. **Reused as-is:** Workers deploy pipeline, anonymous-session auth (matches anonymous feedback), Valibot contracts, adapters, i18n, Vitest/fast-check/Playwright-BDD, CI gates (size-limit, agentic-limits, truth).

**Stage communication:** in-process typed interfaces between packages (modular monolith) — no HTTP between pipeline stages. Per notes.md: simple and maintainable wins; extract a service only when a second consumer actually appears.

**Composition & effect runtime (ADR-0027):** engine packages (`rag-core`, `rag-ingest`, `eval`) and `apps/api` adopt Effect (v3, pinned) as the typed effect runtime — seam signatures return `Effect<A, E, R>`, `RunContext` maps to tagged services, `runPipeline` owns a `Scope`, provider fallback uses `Effect.retry` schedules, and SSE deltas are `Stream` with interruption propagation. The HTTP edge stays Hono + hono-openapi (`Effect.runPromise` bridge), valibot remains the only schema vocabulary (Effect Schema is not adopted), and the frontend stays plain TypeScript (React Query + valibot) — Effect is never exposed over the API contract. Gate: the Workers-runtime spike (bundle size, cold start, tsgo typecheck) must pass before the migration PRs land.

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

**Provisioning & deploys (ADR-0028):** the Cloudflare topology (Worker, R2 bucket, Durable Object binding, static assets, vars/secrets) is declared as code in `apps/api/alchemy.run.ts` and applied with Alchemy (v2, Effect-native IaC) — `bun run deploy` / `deploy:staging` per stage, physical names pinned to the wrangler-era resources, one-time `deploy:bootstrap` (`--adopt`) takeover. The same stack file drives local dev and e2e (`alchemy dev`: workerd + virtual R2/DO on port 8787, no cloud credentials); wrangler is retired. Neon stays provisioned outside the deploy tooling.

### 3.3 The DARS pipeline (Smart Router)

1. **Intent & Principle detection** (cheap tier) → JSON: `category, subcategory, madzhab, needs_principle, principle_tags, query_type (factual|ruling|analogy|comparison|history|aqidah), confidence, reasoning`.
2. **Query decomposition** (cheap tier) → 2–4 sub-queries: always one factual; +principle if `needs_principle`; +Quranic dalil if fiqh; +sanad verification if hadith. +Arabic expansion terms from the Terminology Glossary for variant-term queries (ADR-0014; expansion only, never query translation). The router LLM receives the relevant concept-graph slice (1–2 hop subgraph) as prompt context and picks contextually appropriate Arabic terms; expansion candidates are recorded in the Trace.
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

⚠️ **The embedding default is unproven on our corpus.** Per ADR-0013 (accepted), retrieval is Arabic-canonical: `text_ar`/`embedding_ar` is the primary evidence index; `text_id`/`embedding_id` is a built-from-the-start fallback/fusion track. Phase 1's benchmark harness (#9) is the **go/no-go gate** for the retrieval posture: it compares at least `gemini-embedding-001` and `gemini-embedding-2` on ID→AR and AR→AR recall over the real corpus. The retrieval-layer choice (AR-only vs. ID-fallback fusion) is decided by #9's numbers, not asserted in advance. The dual-index schema is built up front in #4 so the choice is switchable without re-embedding. Gemini free-tier traffic is used for training by Google — acceptable for public religious content and anonymous queries; never route feedback free-text containing personal data through free tiers.

The harness (notes.md: *"test LLM and give a score for Arabic & Indonesian ability"*) is `packages/eval`: versioned test sets (Arabic comprehension, Indonesian generation, citation discipline, translation fidelity), scoring every candidate; results stored and visible in admin; re-run on model releases.

### 3.5 Data layer

Carried over from v1.2 §5 with changes:

- `doc_parents`, `doc_children`, `principle_index`, `concept_links`, `chat_sessions`, `chat_messages` — unchanged in shape, **except dual embeddings per ADR-0013**: `text_ar`/`embedding_ar VECTOR(1536)` (canonical) + `text_id`/`embedding_id VECTOR(1536)` (fallback/fusion), both built from the start. Sparse search via `to_tsvector('arabic'|'indonesian'|'english', …)` (built-in PostgreSQL configs).
- **New (ADR-0014):** terminology concept graph tables — `concept` (language-neutral concept node, ≈ SKOS Concept / WordNet synset), `lemma` (per-language lemma + `embedding VECTOR(1024)` for BGE-M3 candidate retrieval), `concept_relation` (typed: broader/narrower/related/part_of), `lemma_evidence` (lemma ↔ aligned ayah pairs). Distinct from `concept_links` (passage-level) — the terminology graph is term-level.
- **New:** `aligned_pairs` — one row per aligned (Arabic, Indonesian) ayah pair (`pair_key`, `citation`, `text_primary`, `text_secondary`, `morphology` JSONB), written by Quran ingestion (issue #6); the seed corpus for #24's concept-graph build. Lives in the domain pack's migrations (`kajianq-domain`), per ADR-0014's amendment.
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
| Hadith ~40K (v1) | fawazahmed0/hadith-api (ADR-0026) | JSON (ara-*/ind-* editions via jsDelivr) | Unlicense (public domain); attribute + sunnah.com upstream |
| Hadith 650K w/ sanad | Sanadset (Kaggle) | CSV (v2, §9) | Check Kaggle terms; attribute |
| Hadith API | Sunnah.com | JSON API | Key request no longer blocks #7 (ADR-0026); future enrichment only |
| Kitab | Shamela `.bok` / OpenITI TEI | MDB / XML | Classical texts public domain; attribute Shamela/OpenITI |

All attributions ship in `NOTICES/DATASETS.md` (MIT repo; notes.md requirement).

### 4.2 Priority kitab (pre-600 H)

> **v1 scope rule:** the kitab corpus is the listed priority titles plus the complete *verified* corpora of the classical tasawuf lineage (below). Edge editions that are themselves later commentaries are out (matn discipline), and disputed attributions are excluded or labeled — never silently ingested. Persian works (Ayyuha al-Walad, Kimiya-i Sa'adat) are in v1 scope only via the verified Al-Ghazali corpus (#33), not as standalone titles; standalone Persian works are post-v1.

Mudawwanah (Sahnun 240H), Al-Umm (Syafi'i 204H), Syarh Aqidah Thahawiyah (321H), Ihya Ulumuddin (505H), Tarikh Tabari (310H), Al-Kamil (Ibn Athir 630H), Muwatta (179H), Musnad Ahmad (241H), Sunan ad-Darimi (255H), Tahdzib al-Akhlaq (421H); medium: Al-Mabsut (483H, partial), Al-Hidayah (593H). Verify matn dates against OpenITI metadata — many Shamela editions are later commentaries (matn vs sharh discipline per `CONTEXT.md`).

**Complete author corpora (verified)** — issues #33 (Al-Ghazali), #35 (Makki, Qushayri, Jilani). Beyond single priority titles, the corpus targets the complete *verified* works of the classical tasawuf lineage plus Al-Ghazali — all pre-600 H. For every author: the bibliography is LLM-drafted then owner-verified against standard catalogues, and disputed attributions are excluded or explicitly labeled — never silently ingested.

- **Abu Talib al-Makki (d. 386 H)**: Qut al-Qulub fi Mu'amalat al-Mahbub — the foundational tasawuf manual; his other works are not extant.
- **Abu al-Qasim al-Qushayri (d. 465 H)**: Al-Risalah al-Qushayriyyah, Lata'if al-Isharat (tasawuf tafsir), Sharh Asma' Allah al-Husna, Tarikh al-Sufiyyah, Kitab al-Mi'raj; attributed works (e.g., Al-Fusul fi al-Usul) verified before ingestion.
- **Al-Ghazali (d. 505 H)**: the fiqh trilogy (Al-Wajiz, Al-Wasit, Al-Basit), ushul (Al-Mustasfa, Al-Mankhul), aqidah/kalam (Al-Iqtisad fi al-I'tiqad, Tahafut al-Falasifah, Fada'ih al-Batiniyyah, Faysal al-Tafriqah, Iljam al-'Awam, Al-Qistas al-Mustaqim), tasawuf/akhlaq (Ihya Ulumuddin, Mizan al-'Amal, Al-Arba'in fi Ushul al-Din, Bidayat al-Hidayah, Misykat al-Anwar, Al-Maqsad al-Asna, Jawahir al-Qur'an, Al-Munqidz min al-Dhalal), and the Persian works (Ayyuha al-Walad, Kimiya-i Sa'adat — these validate the FA→ID translation path in the harness). Disputed attributions (e.g., Minhaj al-'Abidin, Al-Madnun) excluded or labeled per verification. Note: the Ihya is rich in dhaif hadith — v1 dhaif flagging and v2 per-chain grades (ADR-0012) apply.
- **Abdul Qadir al-Jilani (d. 561 H, Hanbali)**: Al-Ghunyah li Thalibi Tariq al-Haqq, Futuh al-Ghayb, Al-Fath al-Rabbani, Malfuzat, Jala' al-Khawatir (discourses recorded by his students); popular attributions such as Sirr al-Asrar are disputed → excluded or labeled per verification. Adds Hanbali representation to the corpus.

### 4.3 Principle Index

~10–20 entries, **LLM-drafted then verified by the user against Indonesian-language sources** (the core maxims are well documented in Indonesian ushul-fiqh literature; anchors like QS 2:185/2:286/21:107 and Bukhari 39 are checkable without Arabic literacy). Entry shape per v1.2 §4.5. Corpus auto-tagging stays LLM-based with sampled cross-vendor review.

### 4.4 Ingestion pipelines

- **Quran (implemented, issue #6):** `bun run ingest:quran` — acquire Tanzil Uthmani Arabic + Kemenag Indonesian translation + Quranic Arabic Corpus morphology → raw bytes archived to R2 through the ObjectStore seam → the generic `runIngestion` runner (ADR-0021) owns parse + integrity check (6,236 ayah / 114 surah / morphology coverage; the domain `SourceParser` re-parses from the archived bundle, so the archived bytes are the single source of truth) → surah parents with cheap-tier LLM summaries (parent embedding computed from the summary, not full text) + per-ayah children (dual-track `embedding_ar` primary / `embedding_id` fallback per ADR-0013; lemma+root stored per Arabic token per ADR-0014; children written in batches through the RagStore `insertDocChildren` seam) → aligned (AR, ID) ayah pairs persisted for #24's concept-graph build (domain `quran-pair:N:M` key) → IngestionReport persisted to `eval_runs` through the RagStore `insertEvalRun` seam. Idempotent upserts (parents by `source_key`, children by `(parent_id, ordinal)`, pairs by `pair_key`, reports by run id); the CLI is a thin composition root — env access, provider resolution, and I/O all go through the `@app/infra` seams.
- **Hadith (implemented, issue #7):** `bun run ingest:hadith` — acquire per-collection (ara-*, ind-*) editions of fawazahmed0/hadith-api (Unlicense; ADR-0026) → raw bytes archived to R2 through the ObjectStore seam → the generic `runIngestion` runner (ADR-0021) owns parse + integrity check (edition shape, ara/ind alignment on (book, `arabicnumber`) — unmatched pairs and empty-Arabic rows quarantined in the report (`quarantined` = unmatched + `emptyPrimary`), never force-merged; the source's numeric `hadithnumber`/`arabicnumber` are accepted and normalized) → per-(collection, book/section) parents with cheap-tier LLM summaries (parent embedding from the summary; the summary call's cost is recorded by the runner's collector) + per-hadith children (dual-track per ADR-0013; the consolidated grade — dhaif-wins per ADR-0026 — is structured, filterable child metadata, raw per-grader array preserved; empty-ID entries yield `text_id: null`) → aligned (AR, ID) hadith pairs persisted for #24 (`hadith-pair:{collection}:{no}` key, `morphology: []` until the pre-#24 CAMeL Tools enrichment) → IngestionReport persisted to `eval_runs`. Citation renders `HR. Collection no. N (Grade)` from stored fields. Idempotent upserts; thin composition root over the `@app/infra` seams. LLM principle-tagging remains a later step (v1.2 §6.1–6.2).
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
| Gemini embedding underperforms on ID→AR cross-lingual recall | #9 is the go/no-go gate (compares gemini-embedding-001 + gemini-embedding-2 on ID→AR and AR→AR); dual-index schema (ADR-0013) allows AR-only vs. ID-fallback fusion switchable without re-embedding; Terminology Glossary (ADR-0014) bridges ID→AR explicitly, reducing reliance on cross-lingual embedding |
| Machine translation of classical Arabic is wrong | Label + Arabic always shown (ADR-0006); sampled cross-vendor review; translation-fidelity suite in harness; `text_raw` preserved |
| Shamela OCR noise / wrong-author editions | LLM cleaning pipeline; matn/sharh discipline; OpenITI cross-check; 100-chunk manual sampling via translator |
| Kemenag translation licensing | Verify terms before launch; attribute in NOTICES; fallback to alternate ID translation |
| Vendor constraint limits quality ceiling | Harness tracks allowlist candidates per release; allowlist is policy (ADR-0009), revisitable by the owner |
| Free-tier data usage (Google trains on it) | Public content only; no personal data through free tiers; paid tier for sensitive flows |
| Cost overrun at scale | §5 mitigations; budget alerts; generator downgrade path proven by harness |
| Principle Index gaps | Start 10–20, expand iteratively from accepted feedback |

## 7. Plan (12 weeks, approved)

> **Monitoring:** success factors and per-phase metrics live in `docs/SUCCESS_FACTORS_AND_METRICS.md` — the instrument panel for the phases below.

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
| `adr/0007` | User-facing Trace + trace-anchored feedback (amended: typed `Trace`/`TraceEvent`/`CostRecord` contract in `packages/contracts`; trace owned by the user, erased with them on self-deletion) |
| `adr/0008` | Neon Postgres+pgvector behind RagStore adapter (not D1/Vectorize) |
| `adr/0009` | Vendor allowlist (Gemini/Kimi/DeepSeek/Qwen); paid critical path accepted with price discipline; Qwen tie-break |
| `adr/0010` | Terminology Glossary + Arabic query expansion (never query translation) — **superseded by ADR-0014** |
| `adr/0011` | Deep Think: iterative budget-capped retrieval mode, never read-all |
| `adr/0012` | Per-chain hadith grades via Sanadset isnad data (v2); additive migration, no graph DB / GraphRAG |
| `adr/0013` | Arabic as canonical evidence, Indonesian as display; cross-lingual ID→AR retrieval; dual-index schema; #9 as go/no-go gate |
| `adr/0014` | Bilingual terminology concept graph (supersedes ADR-0010's flat table); LLM extraction + human review; prompt-injection consumption (amended: terminology tables relocated to `kajianq-domain`, product tables to `apps/api` — engine schema stays domain-agnostic) |
| `adr/0015` | No novel legal reasoning: surface classical ta'lil/qiyas as cited, never synthesize new rulings; refusal beats confident gap-filling |
| `adr/0016` | No corpus-wide GraphRAG: knowledge ships as bounded curated concept structures (#24, #29, principle index, curated concept_links); revisit gate stated |
| `adr/0017` | Anonymous sessions as first-class KajianQ tables over hosted identity (no Neon Auth in v1) |
| `adr/0018` | AssembledContext carries structured turns + the routed query; Generator owns the final prompt (amended by ADR-0021: stage methods take `RunContext`, Generator/Reviewer return `Draft`) |
| `adr/0019` | Boundary gate scans engine migration SQL, not just TypeScript (closes the `.sql` blind spot in the domain/vendor/DB-client rules) |
| `adr/0020` | Neon plan sizing for the dual 1536-dim vector schema (storage/cost trade-off recorded before the #9 gate) |
| `adr/0021` | `runPipeline` runner owns run scope, run config, and trace assembly; typed dispatch, per-run disposal; cordis deferred behind a revisit trigger |
| `adr/0022` | Provider seam in `rag-core`, generic config-driven vendor adapters in `infra` (zero vendor names in engine `.ts`; vendor data lives in checked-in JSON); fallback chains; streaming with deferred cost |
| `adr/0023` | Role-agent models resolve from `.zcode/agents/` pins on every harness — DSH reads the pin at dispatch (workflow mapping); a pin that fails to resolve is fixed in the DSH provider config (declare the model id), never rerouted |
| `adr/0024` | Fork template-sync ownership: `template-sync.json` lists exactly the byte-identical shared baseline; fork prose (AGENTS.md, docs/ARCHITECTURE.md) and adapted workflows stay fork-owned by omission; `.zcode/` follows template PR #130 as a merge path; adapted files reviewed per template release |
| `adr/0025` | Role-separated GitHub identities: a PreToolUse deny hook redirects role subagents' bare `gh` calls to a `gh-as <role>` wrapper (per-invocation `GH_TOKEN`, token files outside the repo, opt-in `enabled` flag, fail-open); `agent_type` joins the hook-envelope contract |
| `adr/0026` | Hadith v1 source: fawazahmed0/hadith-api (Unlicense, Arabic+Indonesian+grades, 7 collections) replaces hadith-json (unlicensed, ungraded); conservative dhaif-wins grade consolidation, `mutawatir` never self-asserted; Ahmad/Darimi gap accepted; sanad stays in `text_raw` (v2 per ADR-0012); CAMeL Tools morphology deferred to pre-#24. Amended 2026-09-05: weak-class vocabulary enumerated (Mawdu/Batil/Mursal weak, Marfoo not, Mauquf/Maqtu attribution-scope); empty-Arabic rows quarantined (`emptyPrimary`), not run-aborting |
| `adr/0027` | Effect (v3) adopted in engine packages + `apps/api` only — typed error channels, `Schedule` retry, `Scope` lifecycle, `Stream` interruption; amends ADR-0021's revisit trigger; Workers spike as go/no-go gate; valibot + Hono edge + plain-TS frontend unchanged; Effect Schema/`@effect/rpc` not adopted; §2 spike gate passed 2026-09-05 (Appendix A: engine-packages-only dep, api bridges via re-exports) |
| `adr/0028` | Alchemy (v2, Effect-native IaC) owns the whole Worker lifecycle via `apps/api/alchemy.run.ts` — deploys (pinned physical names, one-time `--adopt` bootstrap, `Cloudflare.state()` store) and local dev/e2e (`alchemy dev`: workerd + virtual resources, wrangler retired); Neon stays external; deploy.yml's dead D1 steps removed |

Domain vocabulary: `CONTEXT.md`. Workflow after this spec: `to-spec` → `to-tickets` per the template's agentic pipeline.

---

## 9. v2 Plan — Sanadset: Isnad data & per-chain grades (targeted for v2.0)

### 9.1 Goal

Close v1's integrity gap. v1 stores one flattened grade per matn, but hadith science grades **chains, not texts**: the same matn can be sahih via one isnad and dhaif via another, and weak chains can strengthen each other (hasan li-ghayrihi). A trust-first product cannot stay confidently wrong in this class of answers. v2 makes grades per-chain with grader attribution and shows transmission evidence (ADR-0012).

### 9.2 Scope

- **In:** Sanadset ingestion (650K hadith, tagged sanad/matn); `narrators` + `hadith_chains` tables; reconciliation against the v1 hadith corpus; per-chain grades in citations, answers, UI, and Trace; narrator-reliability answers; Golden Set v2 gate.
- **Out:** full GraphRAG / any graph DB (ADR-0012 — recursive SQL suffices); narrator biographies beyond Sanadset fields; non-hadith chains (e.g., tafsir isnads) — later.

### 9.3 Data layer (additive migration)

- `narrators`: id, canonical_name_ar, name_variants[], kunya, laqab, death_year, tabaqa, per-critic reliability JSONB, metadata.
- `hadith_chains`: id, child_id → doc_children, collection, narrator_ids[] (ordered), grade, grader, source_ref.
- Teacher/student relations derived from chain adjacency — no separate table in v2.
- Existing v1 rows, embeddings, and indexes untouched — no re-ingestion, no re-indexing.

### 9.4 Ingestion (CLI, off-Workers)

Acquire (Kaggle; **human prerequisite: verify license terms**) → parse sanad/matn tags → narrator entity resolution (deterministic Arabic name normalization → LLM assist on unresolved → sampled cross-vendor review; variants recorded) → matn reconciliation (exact → normalized → fuzzy + LLM adjudication; unmatched ingest as new children; low-confidence quarantined, never force-merged) → attach chains; same-matn variants linked via `concept_links` → ingestion report (match rate, resolution rate, quarantine count, cost).

### 9.5 Retrieval, generation, UI

- Retrieval filters: chain grade, narrator.
- Citation: `HR. Bukhari no. N (Sahih — al-Albani; chain via …)`; multiple chains presented neutrally; dhaif flagged as in v1.
- Prompt rules: never upgrade a grade beyond retrieved evidence; note corroboration when chains support it.
- Trace shows chains consulted; takhrij-style answers when cross-collection evidence exists.

### 9.6 Eval & gate

Golden Set v2 traps (ID/EN): conflicting grades per matn; corroboration cases; narrator reliability; takhrij. Cross-vendor faithfulness judge validates per-chain claims against retrieved chains. v1 suite must stay green. Full gate before v2.0.

### 9.7 Tickets

| Ticket | Deliverable | Blocked by |
|---|---|---|
| #27 | v2 spec (parent) | — |
| #28 | V2-P1: Schema & domain model | #4 |
| #29 | V2-P2: Sanadset ingestion (+ Kaggle terms, human) | #28, #7 |
| #30 | V2-P3: Per-chain grades in retrieval/UI/Trace | #29, #11, #12 |
| #31 | V2-P4: Golden Set v2 & v2.0 gate | #30, #20 |

Sequenced V2-P1 → V2-P4; indicative 4–6 weeks, starts after v1.0 (§7).

### 9.8 Risks

| Risk | Mitigation |
|---|---|
| Narrator name-resolution errors (Arabic name variants) | Variant table + LLM assist + sampled cross-vendor review |
| Wrong matn matches | Conservative thresholds; quarantine bucket; spot-checks |
| Kaggle licensing | Verify terms before ingestion (human prerequisite) |
| Scope creep toward GraphRAG | Explicitly out of scope per ADR-0012 |
| v1 answers built on flattened grades | Semantic upgrade documented (CONTEXT.md Grade); v1 Golden Set re-run gates regressions |

---

*Living document (AGENTS.md §2 rule 16): a PR that changes what this spec describes updates the relevant sections in the same PR. Supersedes `INITIAL_IDEA.md` (v1.2), which is frozen history (its §9 prompt library and §5 schema details remain valid where not amended here).*
