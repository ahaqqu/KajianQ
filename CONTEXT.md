# KajianQ / DARS

KajianQ is an open-source Islamic classical-knowledge chatbot for the Indonesian Muslim public, built on DARS — a generic, domain-agnostic RAG engine. Both live in a single monorepo: DARS as reusable workspace packages, KajianQ as the product app.

## Language

**DARS**:
The generic, domain-agnostic RAG engine (ingestion, routing, retrieval, generation, evaluation), shipped as workspace packages under `packages/`. Engine code must contain no Islamic-domain logic. Backronym: "Dynamic Automated RAG Solution"; also evokes Arabic *dars* (lesson/study session).
_Avoid_: platform, framework, core

**KajianQ**:
The end-user product: an Islamic classical-knowledge chatbot, built as an app under `apps/` on top of DARS packages. Indonesian-first chat interface.
_Avoid_: the chatbot, the app (ambiguous — say KajianQ)

**Kitab**:
A classical Islamic source text (author died pre-600 H) ingested from Shamela/OpenITI, cited as Kitab, Author, Volume, Page, Bab.
_Avoid_: book (ambiguous with generic books)

**Madzhab**:
One of the four Sunni legal schools, stored as enum metadata: `hanafi | maliki | syafii | hambali`. Used for retrieval filtering and side-by-side comparison.
_Avoid_: sect, denomination, school (unqualified)

**Matn**:
The original authorial text of a kitab, as opposed to commentary written about it. Of a hadith: the body text, as opposed to its Isnad.
_Avoid_: original text (ambiguous)

**Sharh**:
A commentary written to explain a matn. Ingestion must distinguish sharh from matn and never mix them in one chunk.
_Avoid_: commentary (ambiguous in English prose)

**Grade**:
A hadith's authenticity classification: `mutawatir | sahih | hasan | dhaif`. Dhaif material is always flagged to the user with a warning. v1 stores one headline grade per hadith; from v2 (ADR-0012) a Grade attaches per Isnad, because the same matn can be sahih via one chain and dhaif via another.
_Avoid_: score, rating

**Principle**:
A general Islamic legal/ethical maxim (e.g., *yusr* "ease", *rahmah* "mercy", *dharar* "harm must be removed") used as an interpretive lens when answering why/analogy questions.
_Avoid_: value, theme, concept (ambiguous)

**Principle Index**:
The curated table of ~10–20 Principles with verified source anchors (Quran verses, hadith, kitab passages), retrieved alongside specific rulings so answers keep the big picture.
_Avoid_: principle table, rules index

**Smart Router**:
DARS's 4-stage retrieval orchestrator: (1) intent & principle detection, (2) query decomposition, (3) source routing with metadata filters, (4) context assembly. Not a mere classifier.
_Avoid_: classifier, router (unqualified)

**Trace**:
The per-answer record of how it was built — router intent, sub-queries, retrieved chunks with scores, model identity, tokens, cost. User-visible in expanded form per ADR-0007; a fuller version lives in admin.
_Avoid_: log, debug info

**Golden Set**:
The versioned collection of Indonesian/English test questions with expected sources and citations, run against real services as the integration-test regression gate.
_Avoid_: eval set, test set (unqualified)

**Terminology Glossary**:
The bilingual terminology **concept graph** mapping Indonesian and Arabic religious terms to shared language-neutral concept nodes with typed relations (broader/narrower/related/part_of), living in Postgres (`concept`, `lemma`, `concept_relation`, `lemma_evidence` tables). Built via LLM extraction from aligned Quran pairs with human review; seeded from license-safe resources (QSAC, Quranic Arabic Corpus, Arabic WordNet, Wordnet Bahasa). Supersedes the flat bilingual table of ADR-0010 per ADR-0014. Used for Query Expansion.
_Avoid_: dictionary (ambiguous with generic dictionaries), glossary table (superseded — implies the flat ADR-0010 model)

**Query Expansion**:
Smart Router stage-2 augmentation that emits Arabic term variants from the Terminology Glossary as an additional retrieval channel alongside the Indonesian sub-queries, fused via RRF. The router LLM receives the relevant concept slice (1–2 hop subgraph) as prompt context and picks contextually appropriate Arabic expansion terms; expansion candidates are recorded in the Trace. Expansion only — never replaces the original user query; never whole-query translation (rejected per ADR-0010, carried forward by ADR-0014).
_Avoid_: query translation (a different, rejected mechanism)

**Deep Think**:
The opt-in retrieval mode for comprehensive-coverage questions: iterative rounds (draft → gap detection → re-retrieve) over a deep candidate pool (50–100 chunks) with cheap-tier relevance filtering before assembly, under hard budget caps. The Trace shows coverage (passages examined vs. used). Never "read all documents into the context" (ADR-0011).
_Avoid_: deep research (marketing term), read-all (rejected approach)

**Isnad**:
The ordered chain of narrators through which a hadith was transmitted. From v2 stored as structured rows (narrators + chains), not prose; grading applies to the Isnad, not the Matn (ADR-0012).
_Avoid_: sanad (unqualified romanization drift), chain (unqualified)

**Narrator Graph**:
The relational structure of hadith narrators (rawi) and the Isnads they appear in, built from Sanadset in v2 and traversed with recursive SQL over Postgres. Not a graph database and not GraphRAG.
_Avoid_: knowledge graph (implies GraphRAG-style entity extraction)

## Agentic pipeline

Skill pipeline lives in `.agents/skills/` (router: `agentic-workflow`). Multi-agent orchestration lives in `manager` (spawns role subagents per phase; role models configured in `.zcode/agents/`). Reviews route through `code-review` — the single review entry point; thermos depth is mandatory for code-touching PRs, skippable only for docs/skill/non-code changes. Findings can be posted as itemized PR comments via `thermos-with-comments` (the manager's reviewer role). Domain guardrails that the skills enforce: `dars-pluggability` (pluggable-by-design) and `kajianq-traceability` (traceable-by-design).
