# Architecture (v1.0 — KajianQ & DARS)

Pluggable · Traceable · Price-disciplined · Performance · Cross-Platform · Polished · Secure · Observable · Maintainable · Available · Reliable · Reproducible · Agentic · EN / ID

## Purpose

This document explains **why** the system is built this way, and which of the
template's engineering principles still hold. For normative rules agents must
follow, see [`AGENTS.md`](../AGENTS.md). For the **living** architecture and
plan — the current package tree, data layer, cost model, and phased plan — see
[`SPECS.md`](../SPECS.md) (AGENTS.md §2 rule 16). Decisions live in
`adr/0005`–`0021`; vocabulary in [`CONTEXT.md`](../CONTEXT.md).

This fork descends from `agentic-project-template`. Its `docs/ARCHITECTURE.md`
was **deliberately not synced** (docs/ is fork-owned in `template-sync.json`):
two of its foundational pillars are superseded here by decision, and it predates
DARS entirely. This file keeps the template's pillar structure, marks each
pillar **Inherited** or **Deviated**, and cites the ADR behind every deviation.
It is stable rationale, not a changelog — when a change makes this document
wrong, update it in the same PR (rule 16 applies to this file too).

---

## 1. Pluggable by design — DARS

Every external dependency and every pipeline stage is replaceable **by
configuration, never by code edit**. The DARS pipeline is typed interfaces in
`packages/rag-core` — `Router`, `Retriever`, `Assembler`, `Generator`,
`Reviewer` — composed in-process (modular monolith, no HTTP between stages). A
single `runPipeline` runner walks the five stages, owns the run scope, and
collects the trace (ADR-0021). All LLM/embedding calls go through the
`Provider` interface; model choice per stage comes from `model_configs` only.
All database access goes through the `RagStore` adapter; blob storage through
the `ObjectStore` adapter (ADR-0008). The vendor allowlist
(Gemini/Kimi/DeepSeek/Qwen, ADR-0009) is policy, enforced by the gate.

Gated by: `bun run boundary` (`scripts/check-boundary.mjs` — no Islamic-domain
identifiers, vendor names, or direct DB clients in engine/shared packages,
ADR-0019) and `bun run truth` (no dependency without an importer).

## 2. Traceable by design — KajianQ

**Never hide the machinery** — a hard product boundary (spec §1.5), not a
nice-to-have. Every answer persists a full `answer_traces` record: router
intent, sub-queries (including Query Expansion candidates, ADR-0014), retrieved
chunks with scores (`rrf_score`, `rank_dense`, `rank_sparse`), routing filters,
model identity, tokens in/out, latency, computed cost. `Trace` / `TraceEvent` /
`CostRecord` are typed in `packages/contracts` and consumed by the pipeline,
PWA, admin, and eval from one shape; `TraceEvent` is a strict discriminated
union — an unknown kind fails `v.parse` (ADR-0007 amendments). The
`runPipeline` runner is the single trace collection point; stages append
`llm_call` / `refusal` / `review` through `RunContext.record` — never by
hand-assembling a trace (ADR-0021). Refusal and suppression are recorded with
reason and stage. A trace is owned by the user it answers and is erased with
them on anonymous self-deletion. Every batch operation (ingestion, eval,
glossary build, narrator resolution) produces a report with sampled-review
scores, quarantine count, and cost.

Gated by: contract tests in `packages/contracts` (unknown `kind` fails
`v.parse`); the run-cost invariant (a run's recorded cost equals the sum of its
recorded LLM calls).

## 3. Cost — price-disciplined, not zero-cost

**Deviated from the template (ADR-0009 fork guardrail amendment).** The
template's "zero-cost free tier, never paid services on the critical path" does
not hold here: no free tier exists at generator quality among the allowlisted
vendors, so **paid LLM/embedding APIs are accepted in the critical path**.
Consequences that bind every model decision:

- **Price is weighed in every model decision** — never pick a paid model by
  default when a free-tier allowlist model meets the quality bar.
- **Free tiers where quality allows** — embeddings (`gemini-embedding-001`) and
  the router's cheap tier ride free tiers; generator/quality tiers are paid.
- **Cost is traced per query** — the typed `CostRecord` in
  `packages/contracts`, attached to `answer_traces`; an untraced call is a
  defect (rule 4).
- **Never route personal data through free tiers** — feedback free-text and
  account-adjacent flows use paid tiers.
- The **#9 embedding benchmark is the go/no-go gate** for the retrieval
  posture (AR-only vs. ID-fallback fusion); the dual-index schema (ADR-0013,
  sized in ADR-0020) keeps the choice switchable without re-embedding.

What remains true from the template: infrastructure runs in free quotas where
possible — Workers, Static Assets, R2, and Neon's free tier at small scale.
The generator choice swings ~6× per 1K queries (spec §5); the harness
(`packages/eval`) re-validates candidates so cost stays a measured decision.

Gated by: per-query cost records in `answer_traces`; `bun run size-limit`.

## 4. State — server-authoritative, not local-first

**Deviated from the template (deliberately, spec §3.1).** The template's
local-first pillar (`packages/local-first`: IndexedDB source of truth, LWW
CRDT sync, offline-first) is **dropped** — chat requires a live LLM and
retrieval; an offline mode cannot answer. Instead:

- **Postgres (Neon) is the single durable copy**, accessed only through the
  `RagStore` adapter (ADR-0008): corpus, `answer_traces`, chat sessions and
  messages, feedback, Golden Set, eval ledger, model configs.
- **Anonymous sessions are first-class** — `users` / `sessions` tables, 30-day
  Bearer tokens (SHA-256-hashed), no hosted identity in v1 (ADR-0017).
- **Erasure is complete**: `deleteUserCascade` removes the user's sessions,
  chat, feedback, and traces (`ON DELETE CASCADE`) — the anonymous user's right
  to erasure wins over trace retention (ADR-0007 amendment).
- **Raw sources are immutable**: `text_raw` is never overwritten; re-runnable
  ingestion is idempotent (AGENTS.md rule 13).

The PWA remains installable with a cached shell, but product data requires the
network. There is no client sync protocol and no `SCHEMA_VERSION` client
migration path.

Gated by: RagStore adapter tests (idempotent upserts, immutable `text_raw`);
cascade-delete tests.

## 5. Performance — fast on slow hardware *(inherited)*

The initial JS bundle is under 200 KB gzipped. Non-critical code is
lazy-loaded by route. CSS is build-time only via Tailwind — no runtime
CSS-in-JS. Large datasets (traces, admin lists) are windowed or paginated.

Gated by: `bun run size-limit` (currently ~125 kB).

## 6. Cross-platform — one codebase, every device *(inherited)*

A React 19 PWA: installable, mobile-first, updated through a Service Worker
with a versioned precache and update-prompt flow. The app shell is served via
Workers Static Assets so asset requests stay free. Offline capability applies
to the **shell only** — product features are online (see §4).

Gated by: Playwright-BDD E2E smoke.

## 7. Polished — looks good and feels right *(inherited)*

Responsive from mobile to desktop; information-dense layouts without excessive
whitespace (an explicit user preference, spec §2.3); optimistic interactions;
accessibility built in (axe audits gate the BDD suite); copy externalized en/id
(Indonesian-first product copy); dates and numbers via the Intl API.

Gated by: axe audits (serious/critical violations fail the run).

## 8. Secure — defense in depth *(inherited mechanics, amended seams)*

Every external boundary is validated. Sessions are anonymous Bearer tokens —
stored in **Postgres via the RagStore seam** (deviation from the template's
D1; ADR-0017, which also rejects hosted identity for v1). No custom crypto.
Secrets injected via `wrangler secret`; nothing sensitive in the repository.
Account deletion cascades across all data stores, including `answer_traces`
(ADR-0007 amendment).

- **Rate limiting** — `@app/rate` (`packages/rate`): one Durable Object per
  key in production (global across isolates and POPs, alarm-based eviction);
  bounded in-memory fallback for local dev/tests only. Inherited from the
  template as a template-sync merge path.
- **Secure headers** — `@app/hardening` (`packages/hardening`): one shared
  CSP/COOP/CORP/HSTS/Permissions-Policy policy; every request (API and SPA)
  flows through the Hono stack, so headers, CORS, and rate limiting cover
  static assets too. ZAP findings may only be suppressed in
  `.github/zap-rules.tsv` with an inline justification; staging runs with
  `fail_action: true`.

| Layer | Tool | When |
|---|---|---|
| Static analysis | Semgrep | Every PR |
| Dependency vulnerabilities | OSV-Scanner | Every PR |
| Secret scanning | gitleaks | Every PR |
| Dynamic security scan | OWASP ZAP Baseline | Every main merge against staging |
| API fuzzing | Schemathesis | Every main merge against staging |

## 9. Observable — easy to monitor *(inherited)*

Every layer emits structured data: Cloudflare Analytics for infrastructure,
Workers Logs for structured JSON logs with correlation IDs, Sentry
(`@sentry/cloudflare` + `@sentry/react`) errors-only and DSN-gated — with no
DSN the SDKs stay disabled. Session Replay is opt-in (bundle budget). The
product adds its own observability layer: the persisted `Trace` (§2) is
user- and admin-visible, not just logs.

Gated by: structured-log and correlation-ID tests in CI.

## 10. Maintainable — easy to evolve *(inherited, extended by DARS)*

Workers are stateless. All external service interactions pass through adapter
interfaces (`packages/infra`, `packages/rate`, `packages/hardening`) — business
logic never imports Cloudflare-specific types or touches environment bindings
directly. Shared Valibot contracts in `packages/contracts` are the single
source of truth for client and server; hono-openapi generates the OpenAPI
document from the same route definitions. Contracts, types, and tests come
before implementation. All API routes are under `/v1/`; breaking changes get a
new version, never an in-place break.

**Deliberate deviation:** the template's "standard SQL only for portability"
is relaxed — the Smart Router needs `pgvector` HNSW, `tsvector`, and rich
SQL metadata filtering that D1/Vectorize cannot express (ADR-0008). Portability
lives at the **seam**, not the dialect: engine code never imports a DB client,
so swapping the RagStore adapter swaps the backend.

### Monorepo layout

```
.
├── apps/
│   ├── web/                    # React 19 PWA (chat, trace panel, admin routes)
│   └── api/                    # Hono Worker: /v1/*, OpenAPI, ASSETS catch-all
│       └── migrations/         # Product tables (Principle Index, Golden Set)
├── packages/
│   ├── contracts/              # Valibot contracts incl. Trace/TraceEvent/CostRecord
│   ├── infra/                  # Logger, ConfigStore, ObjectStore, RagStore, Provider adapters + engine migrations
│   ├── rag-core/               # DARS: pipeline interfaces + runPipeline
│   ├── rag-ingest/             # DARS: parsers (Tanzil, hadith-json, Shamela), cleaning/translation, chunking
│   ├── eval/                   # DARS: benchmark harness, Golden Set runner, judges
│   ├── rate/                   # @app/rate — RateLimiter adapters (template merge path)
│   ├── hardening/              # @app/hardening — security headers, ASSETS serving (template merge path)
│   └── kajianq-domain/         # THE domain pack: all Islamic-domain logic (+ concept-graph migrations)
├── scripts/                    # check-boundary, agentic-limits, template-truth, openapi-check…
├── docs/ARCHITECTURE.md        # ← this file (stable "why")
├── SPECS.md                    # living architecture & plan (rule 16)
├── AGENTS.md                   # normative rules for agents
├── CONTEXT.md                  # domain vocabulary
├── islamic_classical_rag_spec.md # frozen v1.2 history — never updated
└── adr/                        # 0005–0021, numbered to continue the sequence
```

## 11. Available — degrade, don't crash *(inherited, adapted)*

On flaky networks the API fails with typed errors and the UI surfaces them;
Sentry and other opt-in services degrade silently when unconfigured. Neon is
the durable copy: point-in-time recovery replaces the template's D1 Time
Travel, and a restore drill is a consuming-project runbook (the template's
`RUNBOOK_RESTORE.md` / `QUOTA.md` were intentionally not brought over). The
ObjectStore seam remains the place a real backup/export lands if adopted.

Gated by: post-deploy smoke tests (`staging.yml`, `deploy.yml`) and blocking
ZAP/Schemathesis against staging.

## 12. Reliable — verified before it ships *(inherited + Golden Set)*

Contracts, types, and tests exist before code. Coverage is enforced by a gate.
Property tests verify adapters and handlers. BDD specs describe user-facing
flows. A change that breaks a gate cannot reach production. KajianQ adds the
**Golden Set** (spec §3.7, `packages/eval`): versioned ID/EN questions with
expected sources, required citations, and known traps (dhaif hadith,
cross-madzhab differences, refusal cases) — deterministic citation validity,
cross-vendor faithfulness judging, full suite gating every release plus
nightly, cost-capped smoke per PR.

| Layer | Tool | Required when |
|---|---|---|
| Unit | Vitest | All business logic, schemas, store queries |
| Property | fast-check | Adapter invariants (idempotency, immutability) |
| E2E/BDD | Playwright-BDD | User-facing flows (+ axe accessibility) |
| Golden Set | `packages/eval` | Release gate + nightly; cost-capped smoke per PR |
| Bundle | size-limit | Every PR |
| API fuzz / DAST | Schemathesis / ZAP | Every main merge against staging |
| Security | Semgrep + OSV-Scanner + gitleaks | Every PR |
| Boundary | `scripts/check-boundary.mjs` | Every PR |

Coverage gate: 80% lines/functions/statements, 70% branches over logic globs
(packages, API, web lib) — UI components are covered by BDD + axe instead.

## 13. Reproducible — same environment everywhere *(inherited)*

The dev shell is declarative (`flake.nix` pins Bun/Wrangler when Nix is
available); CI runs the same Bun scripts as local dev. One command onboarding,
no "works on my machine".

## 14. Agentic — built for autonomous development *(inherited + boundary)*

Any agent can understand and modify any module without reading everything:
files ≤300 lines with ≤5 direct imports, typed contracts at every boundary,
explicit shallow dependencies, self-describing structure. The fork adds the
**domain-boundary gate**: engine and shared packages contain ZERO
Islamic-domain logic — domain vocabulary, prompts, and concept graphs live in
`packages/kajianq-domain` and `apps/` only (AGENTS.md rule 1, ADR-0019).

Gated by: `bun run agentic-limits`, `bun run truth`, `bun run boundary`.

## 15. Technology choices

| Layer | Choice | Rationale |
|---|---|---|
| Platform | Cloudflare Workers + Static Assets + R2 | Unified free tier for the serving path; stateless compute at the edge. |
| Database | **Neon Postgres + pgvector behind `RagStore`** | Smart Router needs vector HNSW + tsvector + rich SQL filtering — D1/Vectorize cannot express it (ADR-0008). Dual 1536-dim vector schema sized in ADR-0020. |
| API framework | Hono + hono-openapi | Valibot route definitions produce validation, TS types, OpenAPI 3.1. |
| Auth | **Anonymous sessions in Postgres (RagStore)** | 30-day Bearer tokens; full erasure cascade; hosted identity rejected for v1 (ADR-0017). |
| Migrations | Raw SQL per owning package | Engine (`packages/infra/migrations`), product (`apps/api/migrations`), concept graph (`packages/kajianq-domain/migrations`) — engine schema stays domain-agnostic (ADR-0014 amendment, ADR-0019). |
| LLM / embeddings | `Provider` interface; allowlist Gemini/Kimi/DeepSeek/Qwen; `model_configs` per stage | ADR-0009; paid critical path accepted with price discipline; every call traced. |
| Pipeline | `packages/rag-core`: Router → Retriever → Assembler → Generator → Reviewer + `runPipeline` | Typed seams, single trace collection point (ADR-0021). |
| Domain pack | `packages/kajianq-domain` | Zero Islamic-domain logic in engine packages (AGENTS.md rule 1). |
| Storage | R2 via ObjectStore adapter | Raw Shamela exports and `text_raw` backups (ADR-0008). |
| Rate limiting | `@app/rate` (Durable Objects) | Inherited template package; global counter per key. |
| Hardening | `@app/hardening` | Shared CSP/headers policy; ZAP-suppression workflow. |
| Client state | TanStack Query over `/v1` API | **No offline store** — `@app/local-first` dropped with D1 (spec §3.1). |
| Routing / UI | TanStack Router; shadcn/ui + Tailwind | Inherited. |
| PWA | vite-plugin-pwa | Shell precache + update prompt; data requires network. |
| i18n | Build-time en/id translations | Indonesian-first product (spec). |
| Trace contract | `packages/contracts`: `Trace`/`TraceEvent`/`CostRecord` | One shape for pipeline, PWA, admin, eval (ADR-0007 amendments). |
| Evaluation | `packages/eval` + Golden Set | Versioned test sets; #9 embedding benchmark is the retrieval go/no-go gate. |
| Payments | Deferred | Not in KajianQ v1; template guidance (Xendit/Polar behind one adapter) stands if ever adopted. |
| Tooling | Bun scripts; TypeScript strict; Nix optional | Inherited. |

## 16. Tooling

Root `package.json` scripts are the single source of truth for gates:

| Script | Purpose |
|---|---|
| `bun run check` | typecheck (root + all packages) |
| `bun run test` | unit + property tests (coverage gate) |
| `bun run boundary` | engine domain/vendor/SQL boundary gate |
| `bun run agentic-limits` | file-size / import-count caps |
| `bun run truth` | no dependency without an importer |
| `bun run size-limit` | bundle budget (<200 KB gzipped) |
| `bun run e2e` | Playwright-BDD against `wrangler dev` |
| `bun run template-gate` | fails on drift of template-owned files |
| `bun run build` / `dev` / `deploy` / `deploy:staging` | build, local dev, deploys |

## 17. Which document answers which question

| Question | Document |
|---|---|
| Why is it built this way? (stable rationale) | `docs/ARCHITECTURE.md` — this file |
| What is the architecture and plan *now*? | `SPECS.md` (living, rule 16) |
| What rules must agents follow? | `AGENTS.md` |
| What do the domain words mean? | `CONTEXT.md` |
| What was decided, when, and why? | `adr/0005`–`0021` |
| Is it working? (factors, metrics, failure signals) | `docs/success-factors-and-metrics.md` |

When this document and `SPECS.md` disagree, `SPECS.md` wins (it is the living
spec) — and this file is updated in the same PR.