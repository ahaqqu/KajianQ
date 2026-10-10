# KajianQ / DARS

KajianQ is an open-source Islamic classical-knowledge chatbot for the Indonesian Muslim public, built on DARS — a generic, domain-agnostic RAG engine. Both live in a single monorepo: DARS as reusable workspace packages, KajianQ as the product app.

## Language

**DARS**:
The generic, domain-agnostic RAG engine (ingestion, routing, retrieval, generation, evaluation), shipped as workspace packages under `packages/`. Engine code must contain no Islamic-domain logic. Backronym: "Dynamic Automated RAG Solution"; also evokes Arabic _dars_ (lesson/study session).
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
A general Islamic legal/ethical maxim (e.g., _yusr_ "ease", _rahmah_ "mercy", _dharar_ "harm must be removed") used as an interpretive lens when answering why/analogy questions.
_Avoid_: value, theme, concept (ambiguous)

**Principle Index**:
The curated table of ~10–20 Principles with verified source anchors (Quran verses, hadith, kitab passages), retrieved alongside specific rulings so answers keep the big picture.
_Avoid_: principle table, rules index

**Smart Router**:
DARS's 4-stage retrieval orchestrator: (1) intent & principle detection, (2) query decomposition, (3) source routing with metadata filters, (4) context assembly. Not a mere classifier.
_Avoid_: classifier, router (unqualified)

**Source routing**:
The Smart Router's stage 3: choosing which source types a question is answered from and which metadata filters retrieval runs with. The **rules decide and the model only hints** — the sources are the **union** of what a reply's Query category implies and what every Sub-query's own role implies, so the search covers every part the route decomposed (an area no rule covers selects none, so a reading that settled nothing cannot narrow the corpus on a guess, and no role and no lens may narrow that unfiltered selection back), a caller's own filters always win, and the decision is recorded on the Trace as the typed `source_routing` event carrying the selected sources and the exact filter record the searches were handed — exact for everything stage 3 derived; a dimension the caller pinned reaches the store verbatim while the event publishes its normalized projection. The filter dimensions are `sourceType`, `madzhab`, `grade`, `textLayer` and `principleTags`; each is a set, bound as `metadata->>key = ANY($n::text[])`, and a dimension the store cannot express is a failure, never a dropped key.
_Avoid_: index selection (that is one half of the decision), routing hint (that is the model's suggestion, not the decision), reranking (a different stage)

**Authority order**:
The precedence the **system prompt** enforces when the context carries more than one kind of source, per _kaidah usul_: Quran → Hadith (mutawatir > sahih > hasan; dhaif flagged) → Tafsir → Kitab. It says which evidence governs when sources disagree, and it is deliberately **not** the Presentation order.
_Avoid_: source priority (vague), ranking (that is fusion scoring), presentation order (the other one)

**Presentation order**:
The order the **assembler** lays the Generator's context out in: Principles → Quran → Tafsir → Hadith → Kitab → anything the order does not name, last. It says how the evidence is presented — the Principle is first because it is the lens the rest is read through — and it is deliberately **not** the Authority order. A source type the order does not name sorts below every named one rather than being interleaved by score; within a slot, the fused score decides.
_Avoid_: authority order (the other one), source order (ambiguous between the two), context order (vague)

**Filter relaxation**:
What the retriever does when the routing decision's filters match nothing: it **probes** them, one dimension at a time, instead of discarding the whole record. Each probe omits a single dimension, runs a search, and is recorded on the Trace (the dimension, the record the retry ran with, the hits it returned, whether it was adopted); only a drop that finds hits is kept for the run, so the record any search ran with is `intended − every adopted drop`, and a probe that changed nothing leaves the route's own decision intact. It exists because an inferred hint that empties the context makes the answer uncitable, and the wholesale drop it replaces silently widened the question. Bounded to **one diagnosis per run**: the hints are a property of the request, not of one sub-query's embedding.
_Avoid_: fallback search (the Router fallback is a different mechanism, about an unusable reply), retry (unqualified), filter pruning (loses the recorded probe)

**Intent**:
The router's classification of what kind of question was asked — `factual | ruling | analogy | comparison | history | aqidah` — recorded on the answer's Trace and shown in its technical layer. One of the closed classification vocabularies the domain pack owns; a value outside it is unusable, never recorded as an understanding.
_Avoid_: query type (the spec's older field name — the field is `intent` in every stage, trace and contract), category (that is Query category), classification (vague)

**Query category**:
The subject area a question falls in — `quran | hadith | tafsir | fikih | aqidah | tasawuf | sejarah | adab | general` — which decides the decomposition rules that fire and, later, the sources source routing selects. Distinct from Intent: the category says what the question is about, the intent says what kind of question it is.
_Avoid_: subject (ambiguous with a source type), topic, domain (that is KajianQ's whole domain), tag (the Golden Set's labels are tags)

**Sub-query**:
One retrieval query a question is decomposed into (2–4; one when the verbatim question is the only distinct text available). It carries a role (`factual`, `principle`, `dalil`, `sanad`) and an origin (`model`, `rule`, `fallback`), is embedded and searched on its own, and its results are fused with the others'. The role says what the sub-query is for and the origin says what produced it, so a rule-added or fallback sub-query reads as such on the persisted trace row; the user-visible Trace frame's technical layer shows the intent and the sub-query texts, not the role/origin labels.
_Avoid_: fan-out query, expansion (that is Query Expansion), variant (that is a terminology-graph lemma)

**Query decomposition**:
The Smart Router's stage 2: turning one question into the Sub-queries retrieval fans out over. The router LLM phrases them; the domain guarantees the rules' coverage — a factual sub-query always, a principle/dalil/sanad one when its rule fires — and the count.
_Avoid_: query splitting, fan-out (that is the retrieval behaviour, not the stage)

**Router fallback**:
What the router routes to when the model's reply is unusable — unparseable, or a classification outside the vocabularies: one factual Sub-query made of the verbatim question, marked as the fallback on both the sub-query and the intent event, so the Trace never presents it as a classification the model made.
_Avoid_: default route, degraded mode (implies a configuration state rather than a per-reply failure)

**Trace**:
The per-answer record of how it was built — router intent and Query category, Sub-queries with their roles, retrieved chunks with scores, model identity, tokens, cost. User-visible in expanded form per ADR-0007; a fuller version lives in admin.
_Avoid_: log, debug info

**Golden Set**:
The versioned collection of Indonesian/English test questions with expected sources and citations, run against real services as the integration-test regression gate.
_Avoid_: eval set, test set (unqualified)

**Terminology Glossary**:
The bilingual terminology **concept graph** mapping Indonesian and Arabic religious terms to shared language-neutral concept nodes with typed relations (broader/narrower/related/part_of), living in Postgres (`concept`, `lemma`, `concept_relation`, `lemma_evidence` tables). Built via LLM extraction from aligned Quran pairs with human review; seeded from license-safe resources (QSAC, Quranic Arabic Corpus, Arabic WordNet, Wordnet Bahasa). Supersedes the flat bilingual term table (ADR-0014). Used for Query Expansion.
_Avoid_: dictionary (ambiguous with generic dictionaries), glossary table (superseded — implies the flat variant-table model)

**Query Expansion**:
Smart Router stage-2 augmentation that emits Arabic term variants from the Terminology Glossary as an additional retrieval channel alongside the Indonesian sub-queries, fused via RRF. The router LLM receives the relevant concept slice (1–2 hop subgraph) as prompt context and picks contextually appropriate Arabic expansion terms; expansion candidates are recorded in the Trace. Expansion only — never replaces the original user query; never whole-query translation (rejected in favour of expansion; ADR-0014).
_Avoid_: query translation (a different, rejected mechanism)

**Deep Think**:
The opt-in retrieval mode for comprehensive-coverage questions: iterative rounds (draft → gap detection → re-retrieve) over a deep candidate pool (50–100 chunks) with cheap-tier relevance filtering before assembly, under hard budget caps. The Trace shows coverage (passages examined vs. used). Never "read all documents into the context" (ADR-0011).
_Avoid_: deep research (marketing term), read-all (rejected approach)

**Citation**:
A source reference rendered on an answer (e.g. `QS. 2:255`, `HR. Malik no. 18`), grounded against retrieved chunks and resolved for the UI from the answer's persisted trace — never re-parsed from answer text client-side (ADR-0040). The inline span renders as a chip that opens the passage's Arabic original, translation, grade, and source.
_Avoid_: reference link (implies a URL), footnote

**Chat Session**:
An anonymous user's conversation: a `chat_sessions` row whose turns are `chat_messages` (user question, assistant answer with its answer trace). The client persists the session id locally; follow-ups append to it, and "new session" starts a clean one (ADR-0017 stakes, ADR-0040 rehydration).
_Avoid_: chat history (ambiguous with the transcript), thread

**Rehydration**:
Restoring the full transcript — messages plus their derived citation payloads — from the server on reload, via `GET /v1/chat/sessions/:id/messages` (ADR-0040). There is no offline store; chat needs network.
_Avoid_: cache restore, sync

**Dhaif warning**:
The deterministic notice the product appends whenever a cited hadith is graded weak — `[Peringatan] Hadits yang dikutip berderajat lemah (dhaif); tidak dapat dijadikan dalil utama.` — rendered in the UI as a visible warning card, never as ordinary prose (spec §2.2).
_Avoid_: weak-hadith disclaimer (it is a warning, not a disclaimer)

**Machine-translation label**:
The ADR-0006 label shown with every machine-made translation — `Terjemahan mesin — lihat teks Arab asli` — one Indonesian constant, no EN variant, always alongside the Arabic original it points to.
_Avoid_: auto-translate badge (drifts from the fixed copy)

**Feedback anchor**:
The element reference a feedback report carries (#13): a thumbs row anchors `answer`; a flag anchors one Trace element — `chunk` (a trace chunk id), `citation`, `translation`, or `grade` (a citation label) — with exactly one reason category per anchor type (`irrelevant_chunk`, `wrong_citation`, `bad_machine_translation`, `questionable_grade`). The server stores a flag only if the persisted Trace grounds the anchor; flags persist as rating −1. Identifiers come from the shared contract's frames only, never free-form coordinates (ADR-0007).
_Avoid_: report tag, flag type, feedback reason (unqualified)

**Isnad**:
The ordered chain of narrators through which a hadith was transmitted. From v2 stored as structured rows (narrators + chains), not prose; grading applies to the Isnad, not the Matn (ADR-0012).
_Avoid_: sanad (unqualified romanization drift), chain (unqualified)

**Narrator Graph**:
The relational structure of hadith narrators (rawi) and the Isnads they appear in, built from Sanadset in v2 and traversed with recursive SQL over Postgres. Not a graph database and not GraphRAG.
_Avoid_: knowledge graph (implies GraphRAG-style entity extraction)

**Embedding Benchmark**:
The go/no-go gate harness (#9, ADR-0036) that compares candidate embedding models on ID→AR cross-lingual and AR→AR monolingual recall@10 over the real corpus, plus the ADR-0014 expansion micro-task (router LLM picks Arabic expansion terms from a glossary slice). Runs via `bun run eval:embed-bench`; results land in a versioned JSON report the ADR cites. Self-retrieval probes (a doc's own track text as query, reusing its track vector) measure the pure alignment of the embedding space.
_Avoid_: leaderboard comparison (implies hosted benchmarks), recall test (unqualified — the gate measures specific directions with fixed floors)

**Retrieval Posture**:
The decided shape of the retrieval layer from the Embedding Benchmark: which embedding model serves as the `embedder` default and whether serving is AR-only or ID-fallback fusion over the dual-index schema. Recorded in ADR-0036; switchable without re-embedding (ADR-0013).
_Avoid_: retrieval strategy (vague), embedding config (implies the whole provider config)

**Surah-Reference Scoped Expansion**:
The deterministic retrieval path that reads the children of the surah (or the surah of the verse) a question names — via the verbatim question, never via a router sub-query — and adds a bounded window of them alongside the fused hits. Its budget is `SCOPE_EXPANSION_CAP` (default 12, `0` disables), its trace is the typed `scope_expansion` event, and chunks it adds carry `origin: "scope_expansion"` — a label the user-facing Trace frame projects, while the eval outcome reports this path's contribution as `expansion.chunks` beside `expansion.fusedOnlyRetrievalRecall`, the recall of the refs that carry **no** origin label (so every deterministic expansion path is excluded from that leg, not only this one) and for a question that names a reference this path satisfies the scored recall leg by construction. It exists because a short formulaic verse is unreachable for a whole-surah meta-question by similarity alone (#142), and it is keyed on the question so the router's paraphrase cannot move it (#241). Recorded in ADR-0045.
_Avoid_: scope expansion (unqualified — ADR-0014's Arabic term expansion is a different mechanism), reference expansion (implies an explicit `QS. n:m` only), query expansion (that is ADR-0014)

**Retrieved-Verse Neighbourhood Expansion**:
The second deterministic retrieval path (ADR-0049, #274): when the retrieved context already holds a verse, the verses **around** it — its ordinal neighbours in the same parent — join the context. Unlike the surah-reference scoped expansion its trigger is not the question but a **retrieved row**: the anchors are the child ids retrieval returned, the adapter derives each anchor's parent and `ordinal` from the stored row (never from a second source of truth), and a truncating cap spends the budget on the best-ranked evidence's neighbourhood. Bounded twice, both read at the composition root: `NEIGHBOUR_EXPANSION_RADIUS` (default 1, how many ordinals on each side) and `NEIGHBOUR_EXPANSION_CAP` (default 12, how many chunks it may add — an **independent** budget, so a surah-naming Quran question can add the scope cap plus this one). `0` disables either knob; a negative value is a typed config failure. Chunks it adds carry `origin: "verse_neighbours"` and the typed `neighbour_expansion` event records the anchor ids read in priority order plus `returned`/`radius`/`cap`/`truncated`. It exists because the generator extends a retrieved verse into a citation **range** whose head it was never given (#274's `gs-v0-001` incident). Recorded in ADR-0049.
_Avoid_: neighbour expansion (unqualified — ambiguous with the surah-reference scoped expansion above), context window (that is the prompt budget), adjacent-verse retrieval (implies a derived position rather than a stored row)

**Decision model**:
A model that answers typed structured questions (Choice / Score / Noul) over a supplied state instead of generating text — a different capability from chat and embedding, reached through the engine's `Decider` seam (ADR-0042). Its serving role is `decision`; its judgment is always a _screen_, never a verdict on its own. Not a chat model, not a judge.
_Avoid_: judge (reserved for the reviewer), classifier (implies a fixed label set)

**Reviewer pre-gate**:
The decision-model screen that fronts the reviewer LLM (ADR-0042 adoption, #168): one batched decision call judging every citation of a draft ("does the cited passage genuinely support the claim as stated?", Noul, threshold 0.5), run after the deterministic citation validator and before the paid reviewer. All citations cleared → the draft is reviewed-clean and the reviewer is skipped; anything else escalates. **Fail-open**: it can only remove spend on an answer it affirmatively cleared, never carry review quality alone. Always active wherever the decision vendor's key is bound — there is no enable flag (owner decision 2026-09-19).
_Avoid_: citation gate (that is the deterministic validator), reviewer (the LLM tier it fronts), pre-check (vague)

**Refusal**:
The answer the product delivers when it cannot answer from retrieved evidence, carrying the canonical insufficiency sentence (`chat-prompts.ts` rule 1, ID/EN) and the trace's `refusal` event that `detectRefusal` reads. Two shapes share the sentence, and they earn different decisions (#439): a **pure refusal** is a classified refusal whose text carries no grounded span — the sentence, or a polite decline around it — and it ships verbatim: no reviewer call, no product rules, no invented warning; a **hybrid refusal** is the same sentence riding a grounded partial answer (`#436`) — that text is answer content, so the paid reviewer is still skipped while the "Always" product rules are computed for it. The classification is a substring match on the sentence (`isRefusalDraft`) and is deliberately not narrowed: what the classification must never do is skip a control the spec makes unconditional.
_Avoid_: decline (the reviewer prompt's word for a non-refusal draft that declines), soft refusal (unqualified — it names neither shape), fallback answer

**Product rules**:
The deterministic post-processing applied to a draft that cleared the reviewer stage's deterministic gate — on the no-provider/`skipLlm` exit, the ADR-0042 pre-gate skip, reviewer-passed, and (since #439) a hybrid refusal: the Dhaif warning, the Machine-translation label, and the not-a-fatwa/consult-ulama disclaimer. They exist because they are exactly what the model cannot be trusted to remember (spec §2.2 "Grade flag — Always"). Appended, never rewritten; not duplicated when the answer already carries the product's own copy; never applied to a pure refusal — a classified refusal whose text carries no grounded span, i.e. one that cites no weak evidence — while a HYBRID refusal does gain them, because the grade flag and the disclaimer are computed for whatever text actually ships (#439). Which rules appended text is Trace content (#285): every path that applies them records one typed `product_rules` event naming the rule ids that appended text — the ADR-0042 pre-gate skip path included, which records no `review` event — while a run with the rules disabled records none. The event's presence means "the rules ran"; an empty `applied` list means "the rules ran and appended nothing" — not a suppression count, because it does not separate "no rule had a trigger" from "a trigger matched but the copy was already present", the exact-copy case that motivated the event. On a hybrid refusal the event rides beside the refusal's own event, and that pair is the trace's record that the classification did not swallow an "Always" control.
_Avoid_: post-processing (vague — it also covers the citation validator), sanitizer, prompt rules (these are not prompt instructions)

## Agentic pipeline

Skill pipeline lives in `.agents/skills/`; the phase map is the workflow sections of `AGENTS.md`. Multi-agent orchestration lives in `manager` (spawns role subagents per phase; role models configured in `.zcode/agents/`). Reviews route through `code-review` — the single review entry point; thermos depth is mandatory for code-touching PRs, skippable only for docs/skill/non-code changes. Findings can be posted as itemized PR comments via `thermos-with-comments` (the manager's reviewer role). Domain guardrails that the skills enforce: `dars-pluggability` (pluggable-by-design) and `kajianq-traceability` (traceable-by-design). Reviewers must load both — `dars-pluggability` and `kajianq-traceability` — in addition to `code-review` when running the compliance pass over a diff.
