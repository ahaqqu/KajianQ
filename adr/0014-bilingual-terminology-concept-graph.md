# ADR-0014: Bilingual terminology concept graph for query expansion

## Status

Proposed — pending review against spec #1, ADR-0013, and ticket #24. If accepted, it amends #24's "curated bilingual table" model into a concept-graph model and defines the build pipeline and license-safe seed sources.

## Context

Ticket #24 specifies a Terminology Glossary as "a curated bilingual table in `kajianq-domain` mapping Indonesian religious terms to their Arabic variants," seeded from the Kemenag↔Uthmani ayah alignment and consumed by Smart Router stage 2 for query expansion. During review of ADR-0013 (Arabic as canonical evidence), a problem surfaced with this table model: for Arabic↔Indonesian religious vocabulary, 1:1 word translation is the minority case. Arabic is root-and-pattern morphology (جَنَّة / الجَنَّة / جَنَّات / وبالجنة are one lemma), Indonesian is affixing (bersuci / penyucian / sucikan), and the semantic mappings are often 1:many or many:many with hierarchical structure that a flat `id_term → [ar_variants]` set throws away (firdaus is a *narrower* sub-level of jannah, not an interchangeable synonym). A static table also cannot pick the right Arabic expansion for a given query context — "bersuci" before prayer means wudu, after major impurity means ghusl — so disambiguation must happen downstream of the glossary, at the router LLM, not inside a lookup table.

Research into current (2024–2026) standards and tooling converged on a coherent answer across five domains: data modeling, Arabic NLP, Indonesian NLP + cross-lingual embeddings, term extraction from parallel corpora, and knowledge-graph consumption. This ADR records that decision.

## Decision

Adopt a **bilingual terminology concept graph**: a language-neutral concept node (e.g. `paradise`, `ritual_purity`) anchors lemmas in each language, connected by typed SKOS-style relations (`broader`, `narrower`, `related`, `part_of`). Build it from the ~6,236 aligned Quran ayah pairs plus hadith pairs via LLM-driven extraction with human review. Consume it by injecting the relevant concept slice into the router LLM prompt as expansion candidates — never replacing the original query, recorded in the Trace.

### Conceptual model: WordNet synset + ILI, SKOS relations, OntoLex-Lemon sense layer where needed

The concept-oriented model (one concept node → per-language lemmas → typed relations) is the consensus across W3C SKOS (Recommendation, 2009, unsuperseded), the OntoLex-Lemon vocabulary (W3C Community Group), the WordNet synset + Interlingual Index model (maintained as CILI under CC BY 4.0, pushed 2026-07-28), and ISO terminology management (TBX/ISO 30042, IATE). We are not inventing a fringe model — we are implementing a decades-old, well-specified idea in Postgres rather than a triple store. Postgres is the right store for this scale (hundreds to low-thousands of concepts) and consumer (an LLM router that wants JSON, not Turtle); it sacrifices SPARQL and OWL reasoning, neither of which we need, and keeps the option to emit SKOS/OntoLex-Lemon RDF later for interchange. We do not adopt the TBX XML interchange format (irrelevant to an LLM consumer) or consume BabelNet data (CC BY-NC-SA, non-commercial, incompatible with our MIT license).

### Storage: plain Postgres tables

```
concept (            -- ≈ skos:Concept / WordNet synset / ILI
  id uuid pk,
  slug text unique,           -- 'paradise', 'ritual_purity'
  scheme text,                -- 'kajianq-core'
  gloss_en text,              -- curator working gloss (English bridge)
  source text,                -- 'manual' | 'QSAC' | 'AWN' | 'QuranicCorpus' | ...
  -- optional: ili_id text    -- CILI ID for interop
  created_at timestamptz, updated_at timestamptz
)

lemma (              -- ≈ ontolex:LexicalEntry + canonical Form
  id uuid pk,
  concept_id uuid not null references concept(id) on delete cascade,
  lang text not null,                  -- 'ar' | 'id' (BCP47)
  written_rep text not null,           -- 'جَنَّة' or 'surga' (≈ ontolex:writtenRep)
  translit text,                       -- 'jannah' (optional)
  is_preferred boolean not null default true,  -- ≈ prefLabel vs altLabel
  pos text,                            -- optional
  embedding vector(1024),              -- BGE-M3, for candidate retrieval
  unique (concept_id, lang, written_rep)
)

concept_relation (   -- ≈ skos:broader / narrower / related / part_of
  id uuid pk,
  source_id uuid not null references concept(id) on delete cascade,
  target_id uuid not null references concept(id) on delete cascade,
  rel_type text not null,              -- 'broader' | 'narrower' | 'related' | 'part_of'
  evidence_ayah_ids uuid[],            -- ayah pairs that justify this relation
  created_at timestamptz,
  check (source_id <> target_id),
  unique (source_id, target_id, rel_type)
)

lemma_evidence (     -- ties every lemma back to the aligned ayah pairs
  lemma_id uuid not null references lemma(id) on delete cascade,
  ayah_pair_id ... not null,           -- FK to the aligned-ayah table (TBD by #4/#6)
  primary key (lemma_id, ayah_pair_id)
)
```

A `lexical_sense` table (≈ OntoLex-Lemon `LexicalSense`) is added only when a lemma genuinely splits across concepts — start without it; the 1:1 lemma↔concept mapping covers the majority of religious terms.

This amends #4's schema (adds four terminology tables) and supersedes #24's "single bilingual table" assumption.

### Build pipeline

1. **Seed.** Import license-safe resources (below) to draft a concept skeleton and reduce cold-start curation.
2. **Lemmatize.** Quran Arabic: use the Quranic Arabic Corpus hand-verified morphology directly — it is gold-standard, covers all 6,236 ayahs, is keyed to diacritized Uthmani text (our exact input), and is verified to collapse جَنَّة / الجَنَّة / جَنَّات to one lemma. No lemmatizer is needed for the Quran; the annotation *is* the lemma. Hadith Arabic: CAMeL Tools v1.6.0 (MIT, maintained, MSA-tuned — expect ~5–15% lemma error on classical forms; cluster by root as a fallback). Indonesian: Stanza Indonesian lemma pipeline (96–98% measured accuracy, Apache-2.0, maintained v1.14.0), with Sastrawi (MIT) as a fast fallback and a curated extension of its root dictionary for Arabic-derived religious vocabulary (wudhu, sujud, rida, syahadat).
3. **Extract.** For each (Arabic, Indonesian) sentence pair, call Qwen3 Max (our ingestion translator, already in the vendor allowlist) with a strict JSON schema via the OpenAI-compatible endpoint or `outlines`. Output: `{ar_phrase, id_phrase, relation, confidence, rationale}` where `relation ∈ {equivalent, broader, narrower, related, part_of}` and phrases are verbatim spans anchorable back to the corpus. ~10K pairs, a few dollars in API calls. Include 3–8 few-shot examples from real Quran data covering every relation type plus a no-term case.
4. **Cluster.** Embed all lemmas with BGE-M3 (MIT, SOTA on MIRACL+MKQA, covers ar+id) into a shared space; generate k-NN candidate pairs (k≈10–20). Run a second LLM pass that takes the deduplicated candidate pairs and resolves them into concept nodes with typed edges — the embeddings group, the LLM types and places (the SCALE 2026 pattern). Sentence encoders are not validated at word level and the dedicated word-alignment toolchain (MUSE/VecMap/fastText) is archived/dormant in 2026, so embeddings are a candidate generator, not the final clusterer. Indonesian is the weak side (MIRACL id 59.0 vs ar 80.2), so keep k generous on the ID side and let the LLM tie-break rather than a cosine threshold.
5. **Review.** Import the consolidated graph into Label Studio (active, 28k stars, supports the `<Relations>` tag for typed relation annotation). Review in uncertainty order: cross-pair merges first, then pairs where two independent LLM passes disagreed, then low-confidence items. The human is the precision gate — LLM self-confidence is not trustworthy enough to auto-accept (Minder et al., 2026); confidence ranks review order, never replaces it.
6. **Load.** Reviewed graph → the four Postgres tables, with `lemma_evidence` tying each lemma to its source ayah pairs.

### Consumption: pragmatic prompt injection, not a heavyweight framework

At Smart Router stage 2 (decomposition), look up the query's surface terms against the `lemma` table, fetch the 1–2 hop neighbor subgraph from `concept_relation`, verbalize it to a compact JSON block, and inject it into the cheap-tier router LLM prompt as Arabic expansion candidates. The LLM — seeing the full Indonesian query in context plus the structured glossary slice — picks the contextually appropriate Arabic terms (wudu for a "before sholat" query, ghusl for "after junub"), which a static lookup cannot do. The original query is never replaced (satisfies #24's "expansion only" rule); the selected expansion terms are written to `answer_traces` (satisfies #24's traceability requirement); results are fused via RRF so a wrong expansion term just retrieves noise that RRF downweights.

This "retrieve concept slice → verbalize → inject" pattern is a named, surveyed category (arXiv:2501.00309 Jan 2025; arXiv:2408.08921 Aug 2024), not a hack. We do not adopt Microsoft GraphRAG (maintenance mode, self-described as not officially supported, oriented to *building* graphs from document corpora via Leiden clustering) or LightRAG (healthy but solves document-graph building, not consulting a hand-built graph). Our graph is small enough to fit in a prompt slice. The graduation path if the graph ever outgrows a single slice is neo4j-graphrag-python (Apache-2.0) on a Neo4j backend, which is designed to *query* an existing graph — a future decision, not today's.

### License-safe seed sources

| Resource | License | Role | Notes |
|---|---|---|---|
| QSAC (Quran Semantic Annotation Corpus) | CC BY 4.0 | Seed — 18 domains / 70 categories / 338 Quranic concept tags | Highest-value license-safe seed for Quranic concepts. Attribute per CC BY. |
| Quranic Arabic Corpus morphology | GPL | Seed (Arabic lemmas) — gold-standard lemma+root for all ayahs | Copyleft + "no modification" clause. Use as reference; keep corrections in a separate layer. |
| Arabic WordNet (OMW) | CC BY-SA 3.0 | Seed/validate — Arabic synsets linked to CILI | Share-alike: AWN-derived data we redistribute must also be CC BY-SA 3.0. |
| Wordnet Bahasa (Indonesian, OMW) | MIT | Seed/validate — Indonesian synsets | No share-alike obligation. |
| CILI (Interlingual Index) | CC BY 4.0 | Interop — shared language-neutral concept IDs | Links AWN + Wordnet Bahasa across languages. |
| Lane's Arabic-English Lexicon | Public domain (pre-1929) | Validate — Arabic lemma definitions/etymology | Internet Archive / Perseus scans. Ground AR-side concept meanings. |
| QuranRAG | MIT | Architecture reference — `graph_retriever.py` BFS boost, polysemy alerts | Study the code pattern for router expansion; verify bundled ontology provenance (traces to GPL corpus). |
| Quranic Ontology (~300 concepts) | GPL | Validate only — concept taxonomy, entity classification | Do not copy/redistribute into the MIT repo. Consult to validate our own. |

Ruled out: BabelNet (CC BY-NC-SA, non-commercial — incompatible with MIT), Lisan al-Arab (no clean permissive digital edition), al-Munawwir dictionary (modern copyright — human reference only, not redistributed), Kemenag/NU/Persis glossaries (no open machine-readable version found — the ID↔AR mapping stays human-curated).

## Consequences if accepted

- **#24 (Terminology Glossary)** is amended: the deliverable becomes a concept graph (four Postgres tables + build pipeline) rather than a flat bilingual table. The glossary's role as query-enrichment-only and its Trace visibility are unchanged.
- **#4 (Neon schema)** gains four terminology tables (`concept`, `lemma`, `concept_relation`, `lemma_evidence`) alongside the existing `concept_links` table (which remains for passage-level relations; the terminology graph is a distinct, term-level structure).
- **#9 (embedding benchmark)** should add an expansion micro-task: given a glossary slice + an Indonesian query, does the model pick the correct Arabic expansion term? This tests the router LLM's multilingual term-selection quality, not just embedding recall, and directly de-risks this ADR's consumption design.
- **#6, #7 (Quran/hadith ingestion)** now produce the aligned pairs the build pipeline consumes; the Quranic Arabic Corpus morphology becomes an ingestion dependency for the Quran portion.
- Arabic-first retrieval (ADR-0013) gains a structured query-expansion channel that bridges Indonesian queries to Arabic evidence, reducing reliance on the embedding model's unverified cross-lingual capability — the concept graph does explicitly and verifiably what concatenation did implicitly and unreliably.

## Open questions

1. **Hadith Arabic lemmatization quality.** CAMeL is MSA-tuned; ~5–15% lemma error on classical hadith is an honest gap with no maintained alternative. Mitigation: root-based clustering fallback + human review. Upgrade path (future ticket): fine-tune CAMeLBERT on a hand-labeled hadith morphology set.
2. **Word-level AR↔ID cross-lingual alignment is unvalidated.** No published benchmark covers this pairing at the word level. The design sidesteps it by using embeddings as a candidate generator and the LLM as the clusterer, rather than betting retrieval on cosine thresholds. #9's expansion micro-task (above) produces the first real evidence.
3. **Glossary completeness at v1.** How much of the religious-term space the first build pass covers is unknown until extraction runs. The graph is designed to grow incrementally — missing concepts degrade to no-expansion (the original query still runs), not to wrong answers, so completeness risk is graceful.
4. **Whether `concept_links` (passage-level) and the terminology graph (term-level) should eventually merge.** They serve different purposes today; revisit after the terminology graph is in use.

## Relationship to existing ADRs

- **ADR-0006:** Unaffected. Machine translation is still produced, stored, and labeled; this ADR governs terminology structure, not translation strategy.
- **ADR-0008:** Compatible. The terminology tables live in the same Neon Postgres behind the RagStore adapter; `lemma.embedding` uses the existing pgvector.
- **ADR-0013:** Complementary. ADR-0013 makes Arabic canonical evidence; this ADR provides the structured bridge that lets Indonesian queries find that Arabic evidence without relying solely on the embedding model's cross-lingual capability.
- **ADR-0009:** Compatible. Qwen3 Max (extraction) and BGE-M3 (candidate embeddings) fit the vendor allowlist; BGE-M3 is a new embedding model for the glossary build, not the RAG corpus (which stays `gemini-embedding-001` per the #9 gate).

## Tools and versions (verified 2026-08-15)

| Tool | Version | License | Role |
|---|---|---|---|
| Quranic Arabic Corpus morphology | v0.4 | GPL | Quran Arabic lemmas (gold-standard) |
| CAMeL Tools | v1.6.0 (2026-06-08) | MIT | Hadith Arabic lemmatization |
| Stanza (Indonesian) | v1.14.0 (2026-07-15) | Apache-2.0 | Indonesian lemmatization |
| Sastrawi (PyPI `sastrawi`) | 1.0.1 | MIT | Indonesian fast fallback + dict extension |
| BGE-M3 (BAAI/bge-m3) | updated 2024-07-03 | MIT | Lemma candidate embeddings |
| Qwen3 Max | (via DashScope) | per ADR-0009 | Term-pair extraction + concept clustering |
| outlines | active (2026-08-15) | Apache-2.0 | Structured output for extraction |
| Label Studio | active (2026-08-14) | Apache-2.0 | Human review of typed relations |