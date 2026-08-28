# KajianQ

An open-source (MIT) Islamic classical-knowledge chatbot for the general
Indonesian Muslim public — chatting in Indonesian and English over a corpus of
original Arabic sources: Quran (Uthmani), hadith (with sanad & grades), and
pre-600 H kitab (fiqh, aqidah, tasawuf, history).

It is built on **DARS** (*Dynamic Automated RAG Solution*) — a generic,
domain-agnostic RAG engine: ingestion, Smart Router, retrieval, generation,
evaluation. Both live in this monorepo (ADR-0005): DARS as workspace packages
under `packages/`, KajianQ as the domain pack (`packages/kajianq-domain`) plus
the product apps under `apps/`. Engine and shared packages contain zero
Islamic-domain logic — the boundary is enforced by a CI gate.

**Status:** v1 foundation. The deployable shell (Workers + React PWA +
`/v1/health` + OpenAPI), the typed trace contract (`Trace`/`TraceEvent`/
`CostRecord`), the RagStore (Neon + pgvector) adapter, the pipeline interfaces
with the `runPipeline` runner, the domain-boundary gate, and the
engine/product/concept-graph migrations are in. The Smart Router, the
chat/feedback/admin surfaces, and the ingestion + eval harness land through
the milestone tickets (plan: `SPECS.md` §7).

## Principles

- **Pluggable by design** — every external dependency and pipeline stage is
  replaceable by configuration, never by code edit. All LLM/embedding calls go
  through the `Provider` interface (vendor allowlist: Gemini, Kimi, DeepSeek,
  Qwen — ADR-0009); all database access through the `RagStore` adapter; blob
  storage through the `ObjectStore` adapter.
- **Traceable by design** — never hide the machinery. Every answer persists a
  full `Trace`: router intent, sub-queries, retrieved chunks with scores,
  model identity, tokens in/out, latency, computed cost — typed in
  `packages/contracts` and consumed by pipeline, PWA, admin, and eval from one
  shape (ADR-0007). The `runPipeline` runner is the single trace collection
  point (ADR-0021).
- **Price-disciplined** — paid LLM/embedding APIs are accepted in the critical
  path (fork guardrail amendment, ADR-0009). Price is weighed in every model
  decision, free tiers are used where quality allows, and cost is traced per
  query.

## Hard boundaries (never cross)

1. Never issue a personal fatwa — present what classical sources say, with
   citations, and refer specific questions to local scholars.
2. Never answer beyond the retrieved context — insufficient retrieval means an
   explicit refusal.
3. Never hide the machinery — every answer carries its full Trace.
4. Never silently machine-translate — kitab translations are labeled, with the
   Arabic always shown (ADR-0006).
5. Dhaif hadith is always flagged with a warning.
6. Never derive a new ruling — classical reasoning (ta'lil, madzhab
   disagreement) is surfaced *as cited*; insufficient evidence → refusal, not
   synthesis (ADR-0015).
7. No corpus-wide inferred knowledge graphs — knowledge ships as bounded,
   curated, human-reviewed structures (ADR-0016).

Full list with wording: `SPECS.md` §1.5.

## How it works

The DARS pipeline is five typed stages in `packages/rag-core` — `Router`,
`Retriever`, `Assembler`, `Generator`, `Reviewer` — composed in-process
(modular monolith, no HTTP between stages). A single `runPipeline` runner
walks the stages, owns the run scope, and collects the trace (ADR-0021).
Retrieval is hybrid — pgvector dense + tsvector sparse, fused with RRF — over
Neon Postgres behind the `RagStore` adapter (ADR-0008); raw sources are
preserved immutably in R2; ingestion and evaluation run as Bun CLI scripts,
never on Workers. Every stage's model is config-swappable via `model_configs`.

## Documentation

| Question | Document |
|---|---|
| What is the architecture and plan *now*? (living) | [`SPECS.md`](SPECS.md) |
| Why is it built this way? (stable rationale) | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| What rules must agents follow? | [`AGENTS.md`](AGENTS.md) |
| What do the domain words mean? | [`CONTEXT.md`](CONTEXT.md) |
| What was decided, when, and why? | [`adr/`](adr/) (0005–0021) |
| Is it working? (success factors, phase metrics) | [`docs/SUCCESS_FACTORS_AND_METRICS.md`](docs/SUCCESS_FACTORS_AND_METRICS.md) |
| Dataset sources & attributions | [`NOTICES/DATASETS.md`](NOTICES/DATASETS.md) |
| Frozen v1.2 spec (superseded history) | [`islamic_classical_rag_spec.md`](islamic_classical_rag_spec.md) |

## License

[MIT](LICENSE).