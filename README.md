# KajianQ

KajianQ is an open-source (MIT) Islamic classical-knowledge chatbot for the
general Indonesian Muslim public. Ask in Indonesian or English and get answers
grounded in original Arabic sources: the Quran (Uthmani), hadith (with
transmission chains and grades), and classical kitab written before 600 H —
fiqh, aqidah, tasawuf, and history.

It runs on **DARS** (*Dynamic Automated RAG Solution*) — a generic,
domain-agnostic answer engine (ingestion, Smart Router, retrieval, generation,
evaluation). The engine itself is deliberately neutral: every piece of
Islamic-domain knowledge lives in its own clearly separated layer.

## The moat — what makes KajianQ different

| Feature | Typical market | KajianQ |
|---|---|---|
| Sources | Quran + Bukhari/Muslim | + pre-600 H kitab (Mudawwanah, Al-Umm, Ihya, Tabari, …) |
| Corpus language | Modern translations | Original Arabic + clearly labeled machine translation |
| Chat language | English/Arabic-first | **Indonesian-first** + English |
| Citations | Partial | Strict: `QS. Surah:Ayah` · `HR. Book no. (Grade)` · `Kitab, Author, Vol:Page:Bab` |
| Madzhab | Opaque | Filterable & comparable; Syafi'i-weighted with transparent gaps |
| Reasoning | Naive RAG | Principle-aware: general maxims retrieved alongside rulings |
| Transparency | Black box | Full user-facing Trace of how each answer was built |
| Data quality | Raw import | Cleaned, translated, and validated before it ships |

## Principles

- **Pluggable** — every external dependency and pipeline stage is replaceable
  by configuration, never by code edit.
- **Traceable** — nothing is hidden: every answer shows how it was built —
  sources consulted, scores, model, latency, cost.
- **Price-disciplined** — paid AI services are accepted where quality demands
  it; price is weighed in every decision and each query's cost is recorded.
- **Server-authoritative** — data lives on the server, not on the device;
  sessions are anonymous-first and fully erasable.
- **Performance** — fast on slow hardware: small initial bundle, lazy-loaded
  routes, no runtime bloat.
- **Cross-platform** — one codebase, every device: an installable,
  mobile-first app.
- **Polished** — responsive and information-dense, accessible by default,
  Indonesian-first copy.
- **Secure** — defense in depth: every boundary validated, plus rate limiting,
  strict headers, and automated security scans.
- **Observable** — structured, correlated logs across every layer; optional
  error tracking that stays silent when unconfigured.
- **Maintainable** — small parts with clear responsibilities; behavior is
  defined and tested before it is built.
- **Available** — degrade, don't crash: clear errors and graceful fallbacks on
  flaky networks.
- **Reliable** — verified before it ships: layered tests plus a Golden Set of
  known trap questions gating every release.
- **Reproducible** — same environment everywhere: one-command setup, and what
  runs in development is what runs in production.
- **Agentic** — built so AI agents can safely understand and work on any part
  of the system, within an enforced domain boundary.

## Hard boundaries (never cross)

1. Never issue a personal fatwa — present what classical sources say, with
   citations, and refer specific questions to local scholars.
2. Never answer beyond the retrieved context — insufficient retrieval means an
   explicit refusal.
3. Never hide the machinery — every answer carries its full Trace.
4. Never silently machine-translate — kitab translations are labeled, with the
   Arabic always shown.
5. Dhaif hadith is always flagged with a warning.
6. Never derive a new ruling — classical reasoning is surfaced *as cited*;
   insufficient evidence means refusal, not synthesis.
7. No corpus-wide inferred knowledge graphs — knowledge ships as bounded,
   curated, human-reviewed structures.

## How it works

Behind the scenes, every question passes through five steps:

1. **Understand** — the Smart Router reads the question: the topic, whether a
   general principle or a specific ruling is needed, and any madzhab context.
2. **Retrieve** — the question is expanded into a few focused sub-queries and
   the corpus is searched in Arabic and Indonesian, matching both meaning and
   exact wording.
3. **Assemble** — the most relevant passages are gathered in authority order:
   Principles first as a lens, then Quran, hadith, and kitab.
4. **Generate** — the answer is written in your language, with the Arabic
   original shown for every quoted passage and strict citations.
5. **Review** — citations are checked automatically, weak (dhaif) hadith is
   flagged, and a sample of answers is judged for faithfulness by a different
   AI vendor than the one that wrote them.

Every answer carries its full **Trace** — the sub-questions asked, the sources
consulted with their relevance scores, the model used, and the cost — visible
in the app, never hidden.

## Built with AI

KajianQ is developed agentically — AI agents write the code under explicit
working rules ([`AGENTS.md`](AGENTS.md)).

**Agentic development (now):**

- **Harness:** DeepSeek Harness, zcode
- **Provider:** Ollama Cloud Pro
- **Models:** kimi-k3, glm-5.3, glm-5.3-flash

**Runtime LLM (later):** the chat product's own LLM stack is a later choice —
the engine is model-agnostic by design, and the vendor/model selection is
configuration, decided per pipeline stage.

## Go deeper

For readers who want the full picture, the working documents are open:

| Question | Document |
|---|---|
| What is the architecture and plan *now*? | [`SPECS.md`](SPECS.md) — the living spec |
| Why is it built this way? | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — stable design rationale |
| Is it working? (success factors & metrics) | [`docs/SUCCESS_FACTORS_AND_METRICS.md`](docs/SUCCESS_FACTORS_AND_METRICS.md) |
| How is it developed? (working rules, incl. AI agents) | [`AGENTS.md`](AGENTS.md) |
| What do the domain words mean? (Kitab, Madzhab, Isnad…) | [`CONTEXT.md`](CONTEXT.md) |
| Where did the idea start? (original v1.2 spec, frozen) | [`INITIAL_IDEA.md`](INITIAL_IDEA.md) |

## Data sources & attribution

All corpus texts keep their attributions — the Quran and its translations
(Tanzil, Kemenag), hadith collections, and classical kitab (Shamela, OpenITI).
See [`NOTICES/DATASETS.md`](NOTICES/DATASETS.md) for the full list.

## License

[MIT](LICENSE).