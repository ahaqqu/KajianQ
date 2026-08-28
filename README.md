# KajianQ

An open-source (MIT) Islamic classical-knowledge chatbot for the general
Indonesian Muslim public — chatting in Indonesian and English over a corpus of
original Arabic sources: Quran (Uthmani), hadith (with sanad & grades), and
pre-600 H kitab (fiqh, aqidah, tasawuf, history).

It is built on **DARS** (*Dynamic Automated RAG Solution*) — a generic,
domain-agnostic RAG engine: ingestion, Smart Router, retrieval, generation,
evaluation. Both live in this monorepo: DARS as workspace packages under
`packages/`, KajianQ as the domain pack (`packages/kajianq-domain`) plus the
product apps under `apps/`. Engine and shared packages contain zero
Islamic-domain logic — the boundary is enforced by a CI gate.

**Status:** v1 foundation. The deployable shell (Workers + React PWA +
`/v1/health` + OpenAPI), the typed trace contract (`Trace`/`TraceEvent`/
`CostRecord`), the RagStore (Neon + pgvector) adapter, the pipeline interfaces
with the `runPipeline` runner, the domain-boundary gate, and the
engine/product/concept-graph migrations are in. The Smart Router, the
chat/feedback/admin surfaces, and the ingestion + eval harness land through
the milestone tickets (plan: `SPECS.md` §7).

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

All engineering principles from `docs/ARCHITECTURE.md`, in brief:

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
- **Maintainable** — small files with explicit dependencies; contracts and
  tests come before implementation.
- **Available** — degrade, don't crash: clear errors and graceful fallbacks on
  flaky networks.
- **Reliable** — verified before it ships: layered tests plus a Golden Set of
  known trap questions gating every release.
- **Reproducible** — same environment everywhere: one-command onboarding, and
  CI runs the same scripts as local dev.
- **Agentic** — built so AI agents can safely understand and modify any
  module, within an enforced domain boundary.

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

Full list with wording: `SPECS.md` §1.5.

## How it works

The DARS pipeline is five typed stages in `packages/rag-core` — `Router`,
`Retriever`, `Assembler`, `Generator`, `Reviewer` — composed in-process
(modular monolith, no HTTP between stages). A single `runPipeline` runner
walks the stages, owns the run scope, and collects the trace. Retrieval is
hybrid — pgvector dense + tsvector sparse, fused with RRF — over Neon Postgres
behind the `RagStore` adapter; raw sources are preserved immutably in R2;
ingestion and evaluation run as Bun CLI scripts, never on Workers. Every
stage's model is config-swappable via `model_configs`.

## Documentation

| Question | Document |
|---|---|
| What is the architecture and plan *now*? (living) | [`SPECS.md`](SPECS.md) |
| Why is it built this way? (stable rationale) | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| What rules must agents follow? | [`AGENTS.md`](AGENTS.md) |
| What do the domain words mean? | [`CONTEXT.md`](CONTEXT.md) |
| What was decided, when, and why? | [`adr/`](adr/) |
| Is it working? (success factors, phase metrics) | [`docs/SUCCESS_FACTORS_AND_METRICS.md`](docs/SUCCESS_FACTORS_AND_METRICS.md) |
| Dataset sources & attributions | [`NOTICES/DATASETS.md`](NOTICES/DATASETS.md) |
| Frozen v1.2 spec (superseded history) | [`islamic_classical_rag_spec.md`](islamic_classical_rag_spec.md) |

## License

[MIT](LICENSE).