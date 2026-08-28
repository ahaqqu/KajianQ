---
name: dars-pluggability
description: Enforce pluggable-by-design when building or reviewing DARS/KajianQ code. Use whenever you add, change, or review a pipeline stage, provider call, persistence call, or package boundary in the KajianQ monorepo — especially anything touching packages/rag-core, rag-ingest, eval, infra, or contracts.
---

# DARS Pluggability

The DARS engine is a reusable, domain-agnostic RAG engine. KajianQ is a domain pack (`kajianq-domain`) + apps on top of it. The pluggability principle: **everything external is replaceable by configuration first, and by code changes when deep customization is needed.** This skill is the working checklist for keeping that true.

## The seams

Know which seam you are standing on before writing code:

| Seam | Interface lives in | Implementations live in | What varies behind it |
|---|---|---|---|
| Pipeline stages | `packages/rag-core` | stage implementations per app wiring | Router, Retriever, Assembler, Generator, Reviewer |
| LLM / embedding vendors | `Provider` in `packages/rag-core` or `packages/infra` | vendor adapters in `packages/infra` | Gemini, Kimi, DeepSeek, Qwen (allowlist per ADR-0009) |
| Persistence | `RagStore` in `packages/infra` | Neon Postgres + pgvector adapter | vectors, metadata filters, chat, traces, feedback, Golden Set |
| Blob storage | `ObjectStore` in `packages/infra` | Cloudflare R2 | raw source archives, `text_raw` backups |

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
- A corpus-wide entity-graph/GraphRAG dependency slipped into `rag-ingest` or `rag-core` as a new package — ADR-0016 requires bounded curated structures and an ADR behind the four-part gate; a dependency change is not a decision record.
