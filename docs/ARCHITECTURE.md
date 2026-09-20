# Architecture (v1.0 — KajianQ & DARS)

Pluggable · Traceable · Price-disciplined · Performance · Cross-Platform · Polished · Secure · Observable · Maintainable · Available · Reliable · Reproducible · Agentic · Privacy · EN / ID

## Purpose

This document explains **why** the system is built this way, and which of the
template's engineering principles still hold. For normative rules agents must
follow, see [`AGENTS.md`](../AGENTS.md). For the **living** architecture and
plan — the current package tree, data layer, cost model, and phased plan — see
[`SPECS.md`](../SPECS.md) (AGENTS.md §2 rule 16). Decisions live in
`adr/` (0005 onward, numbered to continue the sequence); vocabulary in [`CONTEXT.md`](../CONTEXT.md).

This project was originally forked from `agentic-project-template`, but
mechanical template-sync has been retired (ADR-0030). Its `docs/ARCHITECTURE.md`
is project-owned and was never synced wholesale: two of the template's
foundational pillars are superseded here by decision, and it predates DARS
entirely. This file keeps the template's pillar structure, marks each pillar
**Inherited** or **Deviated**, and cites the ADR behind every deviation.
It is stable rationale, not a changelog — when a change makes this document
wrong, update it in the same PR (rule 16 applies to this file too).

---

## 1. Pluggable by design — DARS

Every external dependency and every pipeline stage is replaceable **by
configuration first, and by code changes when deep customization is needed**.
The DARS pipeline is typed interfaces in
`packages/rag-core` — `Router`, `Retriever`, `Assembler`, `Generator`,
`Reviewer` — composed in-process (modular monolith, no HTTP between stages). A
single `runPipeline` runner walks the five stages, owns the run scope, and
collects the trace (ADR-0021). All LLM/embedding calls go through the
`Provider` interface; model choice per stage comes from `model_configs` only.
All database access goes through the `RagStore` adapter; blob storage through
the `ObjectStore` adapter (ADR-0008). The vendor allowlist is policy, enforced
by the gate: **Gemini** (free and paid terms — two rows, because the register
rule keys on terms, not models), **DeepSeek**, **Qwen**, and **TypeSafe AI**
(decision-model only, bench-gated) as of the 2026-09-21 reviewer amendment;
**Moonshot/Kimi was removed** then, and ADR-0009's original allowlist text is
history (ADR-0044's amendment is the operative record).

**The reviewer's cross-vendor separation is deliberately relaxed for the
current key set.** ADR-0009/ADR-0015 named a cross-vendor reviewer to prevent an
answer being graded by the model that wrote it. With no Moonshot key and
TypeSafe's catalogued capability `decide`-only, the reviewer chain is headed by
the same DeepSeek model as the generator. That is accepted by owner decision and
recorded with its revisit trigger (re-editing the chain the moment a second paid
vendor key exists — config only, no code change), rather than left to drift.

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
- **Free tiers where quality allows** — non-personal calls ride free tiers
  (ingestion summaries, tagging, cleaning); every **serving** stage and every
  call flagged personal is on paid terms (§1, §17). The embedder moved to the
  paid-terms `gemini-paid` row on the _same_ API and the same model, so the
  embedding space and the already-ingested corpus vectors stay valid.
- **Cost is traced per query** — the typed `CostRecord` in
  `packages/contracts`, attached to `answer_traces`; an untraced call is a
  defect (rule 4).
- **Never route personal data through free tiers** — feedback free-text,
  chat questions, and every serving call use paid, DPA-covered vendors; the
  review is enforced by a CI test, not by convention (§17).
- The **#9 embedding benchmark is the go/no-go gate** for the retrieval
  posture (AR-only vs. ID-fallback fusion); the dual-index schema (ADR-0013,
  sized in ADR-0020) keeps the choice switchable without re-embedding.

What remains true from the template: infrastructure cost is minimised —
Cloudflare's free DNS (and R2 at small scale) remain, while the serving host and
database moved to the paid netcup VPS for EU residency (ADR-0043/ADR-0044), so
the fixed hosting line is now a paid one. The generator choice swings ~6× per
1K queries (spec §5); the harness (`packages/eval`) re-validates candidates so
cost stays a measured decision.

Gated by: per-query cost records in `answer_traces`; `bun run size-limit`.

## 4. State — server-authoritative, not local-first

**Deviated from the template (deliberately, spec §3.1).** The template's
local-first pillar (`packages/local-first`: IndexedDB source of truth, LWW
CRDT sync, offline-first) is **dropped** — chat requires a live LLM and
retrieval; an offline mode cannot answer. Instead:

- **Postgres (self-hosted on the VPS, ADR-0044) is the single durable copy**,
  accessed only through the `RagStore` adapter (ADR-0008): corpus,
  `answer_traces`, chat sessions and messages, feedback, Golden Set, eval
  ledger, model configs.
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

## 5. Performance — fast on slow hardware _(inherited)_

The initial JS bundle is under 200 KB gzipped. Non-critical code is
lazy-loaded by route. CSS is build-time only via Tailwind — no runtime
CSS-in-JS. Large datasets (traces, admin lists) are windowed or paginated.

Gated by: `bun run size-limit` (currently ~125 kB).

## 6. Cross-platform — one codebase, every device _(inherited)_

A React 19 PWA: installable, mobile-first, updated through a Service Worker
with a versioned precache and update-prompt flow. The app shell is a static
build served by the reverse proxy from disk (`/srv/kajianq/web`), so asset
requests cost no process time. Offline capability applies
to the **shell only** — product features are online (see §4).

Gated by: Playwright-BDD E2E smoke.

## 7. Polished — looks good and feels right _(inherited)_

Responsive from mobile to desktop; information-dense layouts without excessive
whitespace (an explicit user preference, spec §2.3); optimistic interactions;
accessibility built in (axe audits gate the BDD suite); copy externalized en/id
(Indonesian-first product copy); dates and numbers via the Intl API.

Gated by: axe audits (serious/critical violations fail the run).

## 8. Secure — defense in depth _(inherited mechanics, amended seams)_

Every external boundary is validated. Sessions are anonymous Bearer tokens —
stored in **Postgres via the RagStore seam** (deviation from the template's
D1; ADR-0017, which also rejects hosted identity for v1). No custom crypto.
Secrets are supplied as environment variables and read once at the composition
root: the Bun serving entry (`apps/api/src/lib/server.ts`) maps a present key
onto `AppBindings`, and absent means "feature disabled" — never an empty string
that looks configured. On the VPS systemd supplies them through a root-owned
`EnvironmentFile=/etc/kajianq/api.env` (mode 0600, never the unit text, never
argv); the deploy path reads the box's name and key from an env file or
environment secrets. Values come from the owner's environment — never the
repository, which is public.

> **Moved by ADR-0044 (#181).** This paragraph described Cloudflare
> `secret_text` bindings declared in `apps/api/alchemy.run.ts`; the serving path
> is now a self-hosted Bun process behind nginx.
> Account deletion cascades across all data stores, including `answer_traces`
> (ADR-0007 amendment).

- **Rate limiting** — `@app/rate` (`packages/rate`): the process-wide bounded
  in-memory limiter. Post-ADR-0044 the API is one Bun process, so per-process
  and global-for-the-deployment are the same set; the Durable Object backend was
  removed with the Cloudflare serving path. The counter is named by a digest
  (`fnv1aHex`), so no raw IP is held. Originally inherited from the template;
  now project-owned (ADR-0030). **Two consequences of the move, stated rather
  than discovered later:** (1) the counter lives in the process, so a restart or
  a deploy resets it — a burst straddling a restart gets a fresh budget; and (2)
  with the Cloudflare CDN proxy **off** (ADR-0044 decision 4, DNS-only), a
  deployment has no edge POP pooling, so the budget is per-connection to the
  single host. Both follow from "one process, one host" and both are what the
  ADR's revisit trigger names: a scale-out needs a shared counter, and turning
  the proxy on needs `ngx_http_realip_module` first or every visitor behind one
  edge POP shares one budget.
- **Secure headers** — `@app/hardening` (`packages/hardening`): one shared
  CSP/COOP/CORP/HSTS/Permissions-Policy policy. On the VPS the API applies it
  over the Hono stack, so `/v1/*`, `/openapi.json`, and `/docs` carry it;
  static assets are served directly by nginx, which carries the same values in
  its site block's static location (PR #197, in flight — the Worker era applied
  them at the edge to every response, so nginx had to re-apply them). Rate
  limiting is an API-surface policy (ADR-0041): it meters the `/v1` API surface
  only. ZAP findings may only be suppressed in `.github/zap-rules.tsv` with an
  inline justification; staging runs with `fail_action: true`.

| Layer                      | Tool               | When                             |
| -------------------------- | ------------------ | -------------------------------- |
| Static analysis            | Semgrep            | Every PR                         |
| Dependency vulnerabilities | OSV-Scanner        | Every PR                         |
| Secret scanning            | gitleaks           | Every PR                         |
| Dynamic security scan      | OWASP ZAP Baseline | Every main merge against staging |
| API fuzzing                | Schemathesis       | Every main merge against staging |

## 9. Observable — easy to monitor _(inherited)_

Every layer emits structured data: nginx access/error logs and systemd/journald
for the host, structured JSON logs with correlation IDs from the API
(`packages/infra/src/logger.ts` — no IP address in them), Sentry
(`@sentry/bun` + `@sentry/react`) errors-only and DSN-gated — with no
DSN the SDKs stay disabled. Session Replay is opt-in (bundle budget). The
product adds its own observability layer: the persisted `Trace` (§2) is
user- and admin-visible, not just logs.

**What is not yet collected, honestly:** there is no external uptime probe, no
disk-space alert, no TLS-expiry alert, no backup-failure alert, and no host
metrics dashboard. systemd restarts the API and journald records its logs; the
post-deploy Golden Set smoke is the health signal on a code-bearing merge rather
than on a clock. The gaps and the tool-choice constraints are tracked by issue
#194; the operational detail is [`docs/VPS-OPERATIONS.md`](./VPS-OPERATIONS.md)
§4.

Gated by: structured-log and correlation-ID tests in CI.

## 10. Maintainable — easy to evolve _(inherited, extended by DARS)_

The serving process is stateless (nothing survives a restart but the database).
All external service interactions pass through adapter
interfaces (`packages/infra`, `packages/rate`, `packages/hardening`) — business
logic never imports host-specific types or touches environment bindings
directly. Shared Valibot contracts in `packages/contracts` are the single
source of truth for client and server; hono-openapi generates the OpenAPI
document from the same route definitions. Contracts, types, and tests come
before implementation. All API routes are under `/v1/`; breaking changes get a
new version, never an in-place break.

**The deployer is a separate concern, by decision (ADR-0044 decision 3).**
`apps/*` carries app code and build scripts; the build → ship → restart → smoke
path lives in [`provision/vps/deploy/deploy.sh`](../provision/vps/deploy/deploy.sh)
with its CI trigger in `.github/workflows/deploy-vps.yml`; provisioning is under
`provision/vps/`; CI gates are in `.github/workflows/`. A fork can change or
replace the deploy path without touching a line of application code — which is
what makes "app code" mean something. Before the move, `apps/api/alchemy.run.ts`
and six `alchemy:*` scripts made every hosting decision an app-file edit.

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
│   └── api/                    # Hono API: /v1/*, OpenAPI, SPA catch-all (Bun entry src/boot.ts)
│       └── migrations/         # Product tables (Principle Index, Golden Set)
├── packages/
│   ├── contracts/              # Valibot contracts incl. Trace/TraceEvent/CostRecord
│   ├── infra/                  # Logger, ConfigStore, ObjectStore, RagStore, Provider adapters + engine migrations
│   ├── rag-core/               # DARS: pipeline interfaces + runPipeline
│   ├── rag-ingest/             # DARS: parsers (Tanzil, hadith-json, Shamela), cleaning/translation, chunking
│   ├── eval/                   # DARS: benchmark harness, Golden Set runner, judges
  │   ├── rate/                   # @app/rate — RateLimiter adapters
  │   ├── hardening/              # @app/hardening — security headers, ASSETS serving
│   └── kajianq-domain/         # THE domain pack: all Islamic-domain logic (+ concept-graph migrations)
├── provision/vps/              # the deployer + host config-as-code (ADR-0044 decision 3): apply.sh,
│                               # nginx/postgres/logrotate/journald/systemd, deploy/, backup/
├── scripts/                    # check-boundary, agentic-limits, openapi-check…
├── .github/workflows/          # CI gates + the deploy trigger (deploy-vps.yml)
├── docs/ARCHITECTURE.md        # ← this file (stable "why")
├── docs/VPS-OPERATIONS.md      # how to run the box (deploy, Postgres, hardening, monitoring)
├── SPECS.md                    # living architecture & plan (rule 16)
├── AGENTS.md                   # normative rules for agents
├── CONTEXT.md                  # domain vocabulary
├── INITIAL_IDEA.md             # frozen v1.2 history — never updated
└── adr/                        # numbered to continue the sequence
```

## 11. Available — degrade, don't crash _(inherited, adapted)_

**Zero downtime was consciously traded away, against a measured condition
(ADR-0044 decision 2).** There are no live users, so the serving migration was a
**single-shot cutover**: staging first, then prod in one step, with no rollback
runway, no warm second deployment, and no traffic-shift choreography. `git` is
the rollback. This is a recorded choice, not an omission — and it cut only the
uptime half: **the data-integrity criteria did not relax.** The snapshot
bracketing (ADR-0038), the verified transfer, and the restore drill stayed
strict, because those are what a botched migration actually loses. The revisit
trigger is explicit: a live-user base ends this premise and a blue/green or
traffic-shift shape becomes a new ADR.

`deploy.sh` is likewise not zero-downtime by design: it restarts
`kajianq-api.service`, a single-shot replace. A reverse-proxy cache or a second
port would be choreography with no beneficiary today.

On flaky networks the API fails with typed errors and the UI surfaces them;
Sentry and other opt-in services degrade silently when unconfigured. Postgres
is the durable copy, and durability is the snapshot discipline plus the
encrypted-backup layer: `bun run db:snapshot` brackets every paid ingest
(ADR-0038), `provision/vps/backup/` takes daily encrypted backups with a
30-day rolling window, and a restore re-applies erasure (ADR-0043 decision 4).
Point-in-time recovery replaced the template's D1 Time Travel while the store
was managed; self-hosted, the backup + snapshot pair is the recovery story, and
the restore procedure is
[`provision/vps/backup/kajianq-restore.mjs`](../provision/vps/backup/kajianq-restore.mjs)
with the executable drill beside it (§ [VPS-OPERATIONS](./VPS-OPERATIONS.md) §2.6).
Neither layer alone is sufficient for the corpus — that is why the two coexist
at different scopes: the **portable snapshot** is the corpus/`pg_dump` +
manifest layer written through the ObjectStore (survives project deletion, a
plan change, or a re-embed), and the **restic backup** is the whole-database,
encrypted-at-rest, 30-day layer for operating the box. `db:snapshot
restore-plan` prints the exact restore commands.

**The recovery path has one known weakness, recorded:** the restic repository is
today a **local filesystem on the same box** (`/srv/kajianq-backups/restic`); an
external, off-box target is ticket-tracked, and until it exists a disk failure
takes the live store and its backups together. The portable snapshot is the only
copy that leaves the host.

Gated by: post-deploy smoke tests (`deploy-vps.yml`, `staging.yml`) and blocking
ZAP/Schemathesis against staging.

## 12. Reliable — verified before it ships _(inherited + Golden Set)_

Contracts, types, and tests exist before code. Coverage is enforced by a gate.
Property tests verify adapters and handlers. BDD specs describe user-facing
flows. A change that breaks a gate cannot reach production. KajianQ adds the
**Golden Set** (spec §3.7, `packages/eval`): versioned ID/EN questions with
expected sources, required citations, and known traps (dhaif hadith,
cross-madzhab differences, refusal cases) — deterministic citation validity,
faithfulness judging, full suite gating every release plus
nightly, cost-capped smoke per PR. **The faithfulness judge's cross-vendor
separation is relaxed for the current key set** (the reviewer shares the
generator's vendor — §1); what does not relax is the deterministic gate: the
citation validator runs on 100% of answers, and a fabricated citation is refused
regardless of who reviews.

| Layer           | Tool                             | Required when                                    |
| --------------- | -------------------------------- | ------------------------------------------------ |
| Unit            | Vitest                           | All business logic, schemas, store queries       |
| Property        | fast-check                       | Adapter invariants (idempotency, immutability)   |
| E2E/BDD         | Playwright-BDD                   | User-facing flows (+ axe accessibility)          |
| Golden Set      | `packages/eval`                  | Release gate + nightly; cost-capped smoke per PR |
| Bundle          | size-limit                       | Every PR                                         |
| API fuzz / DAST | Schemathesis / ZAP               | Every main merge against staging                 |
| Security        | Semgrep + OSV-Scanner + gitleaks | Every PR                                         |
| Boundary        | `scripts/check-boundary.mjs`     | Every PR                                         |

Coverage gate: 80% lines/functions/statements, 70% branches over logic globs
(packages, API, web lib) — UI components are covered by BDD + axe instead.

## 13. Reproducible — same environment everywhere _(inherited)_

CI pins the Bun version (1.4.0) to match local dev (mise), and the box runs the
same major (`/usr/bin/bun`). The template's
`flake.nix` dev shell is dormant — a nix-based toolchain unification was
evaluated and rejected by the owner (2026-08-28), because the production
environment was hosted and the dev-shell parity value was judged too small for
the added tooling. Do not activate it without a new owner decision; the file
stays because it remains part of the original template tooling. One command
onboarding, no "works on my machine".

## 14. Agentic — built for autonomous development _(inherited + boundary)_

Any agent can understand and modify any module without reading everything:
files ≤300 lines with ≤5 direct imports, typed contracts at every boundary,
explicit shallow dependencies, self-describing structure. The fork adds the
**domain-boundary gate**: engine and shared packages contain ZERO
Islamic-domain logic — domain vocabulary, prompts, and concept graphs live in
`packages/kajianq-domain` and `apps/` only (AGENTS.md rule 1, ADR-0019).

Gated by: `bun run agentic-limits`, `bun run boundary`.

## 15. Technology choices

| Layer            | Choice                                                                                                             | Rationale                                                                                                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform         | **netcup VPS (Germany/EU)**: nginx → Bun (`apps/api`), static build served by the proxy                            | EU/Germany residency for chat content and traces (ADR-0043); one host runs the proxy, API, and database (ADR-0044). Cloudflare/Neon decommissioned. Operating it: [`docs/VPS-OPERATIONS.md`](./VPS-OPERATIONS.md).                                                                                                |
| Database         | **Self-hosted Postgres + pgvector behind `RagStore`**, `pg` over TCP                                               | Smart Router needs vector HNSW + tsvector + rich SQL filtering — D1/Vectorize cannot express it (ADR-0008). Self-hosted for residency (ADR-0043/ADR-0044); dual 1536-dim vector schema sized in ADR-0020. Loopback-only listener, scram over TCP.                                                                 |
| API framework    | Hono + hono-openapi                                                                                                | Valibot route definitions produce validation, TS types, OpenAPI 3.1.                                                                                                                                                                                                                                              |
| Auth             | **Anonymous sessions in Postgres (RagStore)**                                                                      | 30-day Bearer tokens; full erasure cascade; hosted identity rejected for v1 (ADR-0017).                                                                                                                                                                                                                           |
| Migrations       | Raw SQL per owning package                                                                                         | Engine (`packages/infra/migrations`), product (`apps/api/migrations`), concept graph (`packages/kajianq-domain/migrations`) — engine schema stays domain-agnostic (ADR-0014 amendment, ADR-0019). One shared `schema_migrations` ledger; names unique across dirs.                                                |
| LLM / embeddings | `Provider` interface; allowlist Gemini/Gemini-paid/DeepSeek/Qwen (+ TypeSafe `Decider`); `model_configs` per stage | ADR-0009; paid critical path accepted with price discipline; every call traced. **Same-vendor review accepted by owner amendment 2026-09-21** (generator and reviewer both `deepseek:deepseek-v4-flash`; cross-vendor separation relaxed for the current key set, revisit trigger recorded) — ADR-0044 amendment. |
| Pipeline         | `packages/rag-core`: Router → Retriever → Assembler → Generator → Reviewer + `runPipeline`                         | Typed seams, single trace collection point (ADR-0021).                                                                                                                                                                                                                                                            |
| Domain pack      | `packages/kajianq-domain`                                                                                          | Zero Islamic-domain logic in engine packages (AGENTS.md rule 1).                                                                                                                                                                                                                                                  |
| Storage          | R2 via ObjectStore adapter (transitional)                                                                          | Raw Shamela exports, `text_raw` backups, and snapshot dumps (ADR-0008); a snapshot carrying personal data is encrypted at rest before it lands on the VPS (ADR-0043 decision 5).                                                                                                                                  |
| Rate limiting    | `@app/rate` (process-wide in-memory)                                                                               | One API process, so a per-process counter is global (ADR-0044); the key is a digest, never a raw IP.                                                                                                                                                                                                              |
| Hardening        | `@app/hardening`                                                                                                   | Shared CSP/headers policy; ZAP-suppression workflow.                                                                                                                                                                                                                                                              |
| Client state     | TanStack Query over `/v1` API                                                                                      | **No offline store** — `@app/local-first` dropped with D1 (spec §3.1).                                                                                                                                                                                                                                            |
| Routing / UI     | TanStack Router; shadcn/ui + Tailwind                                                                              | Inherited.                                                                                                                                                                                                                                                                                                        |
| PWA              | vite-plugin-pwa                                                                                                    | Shell precache + update prompt; data requires network.                                                                                                                                                                                                                                                            |
| i18n             | Build-time en/id translations                                                                                      | Indonesian-first product (spec).                                                                                                                                                                                                                                                                                  |
| Trace contract   | `packages/contracts`: `Trace`/`TraceEvent`/`CostRecord`                                                            | One shape for pipeline, PWA, admin, eval (ADR-0007 amendments).                                                                                                                                                                                                                                                   |
| Evaluation       | `packages/eval` + Golden Set                                                                                       | Versioned test sets; #9 embedding benchmark is the retrieval go/no-go gate.                                                                                                                                                                                                                                       |
| Payments         | Deferred                                                                                                           | Not in KajianQ v1; template guidance (Xendit/Polar behind one adapter) stands if ever adopted.                                                                                                                                                                                                                    |
| Tooling          | Bun scripts; TypeScript strict; Nix optional                                                                       | Inherited.                                                                                                                                                                                                                                                                                                        |

## 16. Tooling

Root `package.json` scripts are the single source of truth for gates:

| Script                                                                        | Purpose                                                                                 |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `bun run check`                                                               | typecheck (root + all packages)                                                         |
| `bun run test`                                                                | unit + property tests (coverage gate)                                                   |
| `bun run boundary`                                                            | engine domain/vendor/SQL boundary gate                                                  |
| `bun run agentic-limits`                                                      | file-size / import-count caps                                                           |
| `bun run size-limit`                                                          | bundle budget (<200 KB gzipped)                                                         |
| `bun run e2e`                                                                 | Playwright-BDD against the local **Bun** entry (`apps/api/src/boot.ts`)                 |
| `bun run build` / `dev` / `api:serve` / `deploy`                              | web build, local dev, the Bun server, the VPS deploy (`provision/vps/deploy/deploy.sh`) |
| `bun run db:status:all` / `db:up:all` / `db:down:all`                         | the three migration sets against `DATABASE_URL` in one pass                             |
| `bun run db:snapshot <create\|verify\|require\|list\|download\|restore-plan>` | the paid corpus's durability layer (ADR-0038); `require` gates a paid run               |
| `bun run provider:smoke`                                                      | drills every keyed vendor through the `Provider` seam; absent keys report NOT RUN       |
| `bun run eval:run` / `eval:smoke`                                             | the Golden Set harness and its cost-capped PR/CI subset                                 |
| `bun run ingest:quran` / `ingest:hadith` (+ `-- --check`)                     | operator-driven corpus ingestion (ADR-0037); `--check` proves the store is untouched    |

## 17. Privacy by design — GDPR posture

Privacy is a design property, not a compliance layer bolted on: sessions are
**anonymous by design** (ADR-0017 — no accounts, no email, no cookies, so the
identifier says nothing about the person), only the minimum is kept (a SHA-256
token hash, the transcript, the persisted Trace, optional feedback free-text),
and every stored category carries a **config-owned retention value** as a fixed
number rather than "as long as needed", because Art. 13(1)(e) requires an
answer the product can render. **Erasure is a first-class flow**:
`DELETE /v1/auth/me` cascades the user's entire subtree (sessions, chat, traces,
feedback), and a backup restore re-applies it so a restored row cannot
resurrect deleted data. Personal data routes only through paid, DPA-covered
vendors — never a free tier — as a **decided rule** that `personalDataAllowed`
gates at the `Provider` seam (ADR-0009 amendment). **It is enforced on the
serving path, and CI proves it.** Every serving call site declares
`personalData: true` from its stage seam's own type, as a **required literal**
(`RouterProvider`, `GeneratorProvider`, `ReviewerProvider`, `RetrieverEmbedder`
in `packages/kajianq-domain/src/chat-*.ts`) — dropping the flag is a compile
error, not a silent degradation — and the serving chains carry paid,
personal-data-allowed heads (`deepseek` for `cheap`/`generator`/**reviewer**,
`gemini-paid` for `embedder`). `apps/api/src/lib/personal-data-serving.test.ts`
fails CI if a serving role loses its keyed personal-data-allowed candidate or a
free-tier vendor returns to a chain head, so the rule cannot be undone by an
edit to `models.json` alone. The earlier state — no call site set the flag, so a
chat question could ride free-tier Gemini — is closed (ADR-0043's recorded gap;
the Art. 30 record's §10 item is closed too). ADR-0043
is the decision record; the
sub-processor register, the retention values, and their implementation status
live in [`GDPR-ARTICLE-30-RECORD.md`](./GDPR-ARTICLE-30-RECORD.md) and move
together with any change to the posture — a new processor or hosting region
joins the register in the same PR that introduces it.

Gated by: cascade-delete tests (§4); the privacy guardrail and its Definition
of Done line in [`AGENTS.md`](../AGENTS.md); the GDPR item in
`.agents/skills/guided-implementation/SKILL.md`.

## 18. Which document answers which question

| Question                                           | Document                                                 |
| -------------------------------------------------- | -------------------------------------------------------- |
| Why is it built this way? (stable rationale)       | `docs/ARCHITECTURE.md` — this file                       |
| What is the architecture and plan _now_?           | `SPECS.md` (living, rule 16)                             |
| What rules must agents follow?                     | `AGENTS.md`                                              |
| What do the domain words mean?                     | `CONTEXT.md`                                             |
| What was decided, when, and why?                   | `adr/` (0005 onward)                                     |
| Is it working? (factors, metrics, failure signals) | `docs/SUCCESS_FACTORS_AND_METRICS.md`                    |
| How do I deploy / operate / restore the box?       | `docs/VPS-OPERATIONS.md`                                 |
| How was the box hardened, step by step?            | `docs/VPS-HARDENING-RUNBOOK.md`                          |
| How was (is) the data move executed?               | `docs/VPS-CUTOVER-RUNBOOK.md` + `…-RECORD.md`            |
| What personal data is kept, for how long, by whom? | `docs/GDPR-ARTICLE-30-RECORD.md` (derives from ADR-0043) |

When this document and `SPECS.md` disagree, `SPECS.md` wins (it is the living
spec) — and this file is updated in the same PR.
