---
name: dars-pluggability
description: Enforce pluggable-by-design when building or reviewing DARS/KajianQ code. Use whenever you add, change, or review a pipeline stage, provider call, persistence call, or package boundary in the KajianQ monorepo — especially anything touching packages/rag-core, rag-ingest, eval, infra, or contracts.
source: project
---

# DARS Pluggability

The DARS engine is a reusable, domain-agnostic RAG engine. KajianQ is a domain pack (`kajianq-domain`) + apps on top of it. The pluggability principle: **everything external is replaceable by configuration first, and by code changes when deep customization is needed.** This skill is the working checklist for keeping that true.

## The seams

Know which seam you are standing on before writing code:

| Seam                    | Interface lives in                             | Implementations live in              | What varies behind it                                         |
| ----------------------- | ---------------------------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| Pipeline stages         | `packages/rag-core` (`StageEffect` signatures) | stage implementations per app wiring | Router, Retriever, Assembler, Generator, Reviewer             |
| LLM / embedding vendors | `Provider` in `packages/rag-core`              | vendor adapters in `packages/infra`  | Gemini, Kimi, DeepSeek, Qwen (config allowlist)               |
| Persistence             | `RagStore` in `packages/infra`                 | Neon Postgres + pgvector adapter     | vectors, metadata filters, chat, traces, feedback, Golden Set |
| Blob storage            | `ObjectStore` in `packages/infra`              | Cloudflare R2                        | raw source archives, `text_raw` backups                       |

Stages communicate **in-process** through typed interfaces — no HTTP between pipeline stages.

## Hard rules

1. **Zero Islamic-domain logic in engine packages** (`rag-core`, `rag-ingest`, `eval`, `contracts`, `infra`). That includes: madzhab names/enums, hadith grades, principle tags, citation formats (`QS.`/`HR.`/`Kitab, Author, Vol:Page:Bab`), Arabic-script handling, religious prompt text. If a stage needs such a concept, it receives it as typed input (e.g. `metadata filters`, `labels`, `prompt template string`) supplied by the domain pack — the engine never names it.
2. **No vendor or model names in engine or app code.** `Qwen`, `Gemini`, model IDs, and prices appear only in `model_configs` config and in `packages/infra` Provider adapters. Per-stage model selection is config-driven only.
3. **No direct SQL outside the RagStore adapter and migrations.** Engine/app code never imports a DB client. New persistence needs → extend the RagStore interface, then implement it.
4. **Prompts live in the domain pack** (`kajianq-domain` for KajianQ), parameterized by language, and injected into the Generator. Engine code treats prompts as opaque strings with typed slot contracts.

## When adding anything new, ask

- Which seam does this belong behind? If none exists and one is needed, add the interface **first**, then the implementation, then the wiring.
- What is the config knob? If the answer is "there is none, it's hardcoded," stop — that is exactly the defect this skill exists to prevent.
- Does this pull a domain concept into the engine? If yes, invert it: the engine defines a generic type; the domain pack supplies values.
- If I had to swap Neon for SQLite, or Qwen for Kimi, or add a second product with a completely different domain, which files would change? Only adapters, config, and the domain pack — nothing in `rag-core`/`rag-ingest`/`eval`.

## Quick review scan

```sh
# Domain leakage into engine packages — should return nothing but the boundary test itself
rg -i "madzhab|hadith|quran|kitab|isnad|sanad|sahih|dhaif|hasan|mutawatir|hanafi|maliki|syafii|hambali|tafsir|fiqh|aqidah|tasawuf" \
  packages/rag-core packages/rag-ingest packages/eval packages/contracts packages/infra/src

# Vendor/model names outside Provider adapters and config
rg -i "qwen|gemini|deepseek|kimi|moonshot|dashscope" \
  packages/rag-core packages/rag-ingest packages/eval packages/contracts apps

# DB client usage outside RagStore/migrations
rg "@neondatabase|drizzle|pg\\b" packages/rag-core packages/rag-ingest packages/eval apps --glob '!**/migrations/**'
```

Each hit is either a refactor or a conscious, recorded exception in an ADR. There is no third option.

## Anti-patterns seen in RAG codebases (reject in review)

- Helper functions like `fetchMadzhabFilter()` inside `rag-core` — domain enum smuggled into the engine.
- `process.env.QWEN_API_KEY` read anywhere except `packages/infra` vendor adapters.
- Prompt template strings embedded in `rag-core` stage code "temporarily" — they never leave.
- A new table accessed via raw SQL "just for this ticket" — the adapter grows or the ticket is wrong.
- A `Router` implementation that calls a specific vendor SDK — it must hold a `Provider` reference injected at wiring time.
- A corpus-wide entity-graph/GraphRAG dependency slipped into `rag-ingest` or `rag-core` as a new package — the engine requires bounded curated structures behind the four-part gate; a dependency change is not a decision record.

## Effect runtime

The engine's seams are `Effect<A, E, R>`-shaped. When building or reviewing adapters and wiring:

- **Signatures say the failure modes.** `Provider` methods return effects whose failure channel is `ProviderError` (defined in `packages/rag-core/src/provider.ts`); stage methods return `StageEffect<A>` = `Effect<A, StageError, RunContext | Scope>`. Persistence seams carry the closed `StoreError` taxonomy (`transport`/`timeout`/`constraint`/`not_found`/`config`, defined in `packages/rag-core/src/store-error.ts`, re-exported by `@app/infra`). Map raw failures at the seam (`toStageError(stage, ...)`, the adapter's `catch` mapping) — a failure that escapes untyped is a boundary defect, and no error kind may travel via `throw` across a seam.
- **Per-run resources go through the run's `Scope`** (`Effect.addFinalizer` inside a stage), not ad-hoc `defer` arrays; the runner owns the scope. Adapter-level lifecycle (closing HTTP agents, connections) belongs to the wiring layer's `Layer` finalizers when stages are Layer-wired.
- **Config still resolves models.** Effect changes the plumbing, not the rule: no vendor or model names in engine code, model ids arrive as opaque strings from `model_configs`, and personal-data filtering stays in the fallback chain.
- **Retry policy is per-kind `Schedule`s** on the fallback chain (`defaultRetrySchedule` / `perKindRetrySchedule` in `packages/infra/src/providers/retry-schedule.ts`, injectable via `ResolveOptions.retrySchedule`) — do not hand-roll `try/catch` retry loops around provider calls.
- **Bounded concurrency is opt-in at the knob** (e.g. `IngestionDeps.embedConcurrency` via `Effect.forEach`), never an unbounded `Promise.all` over a batch.
- The HTTP edge stays Hono; apps bridge via `@app/rag-core/interop` (`runPipelinePromise`) and `@app/rag-core/interop-stream` (`engineStreamToWeb`). `apps/api` depends on `effect` only for Alchemy's deploy tooling peers (`effect@4-rc` in `apps/api` devDependencies) — engine code imports Effect from the engine packages' own `effect@3` pin, never mixes the two lines.
