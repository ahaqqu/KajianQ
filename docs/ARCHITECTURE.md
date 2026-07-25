# Architecture (v1.0)

Cost · Local-First · Performance · Cross-Platform · Polished · Secure · Observable · Maintainable · Available · Reliable · Reproducible · Agentic · EN / ID

## Purpose

This document explains **why** the system is built this way. For normative rules agents must follow, see [`AGENTS.md`](./AGENTS.md).

---

## 1. Cost — zero-cost free tier

Infrastructure runs entirely within Cloudflare free quotas. Client-side computation is preferred over server-side. The server exists for auth, sync, and persistence only.

This shapes every decision. Filtering, sorting, aggregation, and search happen in the client store. Sync is batched and delta-based. Static assets are served via the free Static Assets binding. Polling loops are forbidden. Per-transaction payment fees are acceptable because they scale with revenue; fixed costs are not.

Every principle has an automated gate in CI. A principle without a gate does not exist.

### Free-tier constraints

| Resource | Free quota |
|---|---|
| Workers | 100k req/day · 10ms CPU/req |
| Static Assets | Not quota-counted |
| D1 | 5M rows read · 100k rows written/day · 5GB |
| R2 | 10GB · 1M Class A · 10M Class B ops/month |
| Cron Triggers | Included |
| Sentry | 5k errors · 10k replays/month |

Staging BDD runs consume the same quotas. Batch writes, clean up after runs, keep headroom.

Gated by: `size-limit`, quota monitoring in CI.

---

## 2. Local-first — works without network

The client store is the source of truth. All reads and writes succeed offline. Sync is opportunistic, never blocking. Conflict resolution is automatic and invisible.

This means the sync protocol is event-driven, not polled. Writes are optimistic into the client store and the UI reacts immediately. Changes persist to IndexedDB in the same tick. Batched sync fires on reconnect, foreground, online events, or explicit flush. The edge is stateless: each request carries enough context to merge and persist independently. Conflicts resolve via CRDT merge without user intervention. One elected leader syncs per browser; peers stay consistent via BroadcastChannel without redundant network traffic. Client and server negotiate schema version compatibility; mismatches surface as update prompts, not silent failures.

Gated by: `fast-check` property tests for merge idempotency and commutativity.

---

## 3. Performance — fast on slow hardware

The initial JS bundle is under 200 KB gzipped. Non-critical code is lazy-loaded by route. Static assets are cache-first via Service Worker. Network is for data only.

CSS is build-time only via Tailwind. There is no runtime CSS-in-JS. Images use responsive variants, client-side compression before upload, and lazy loading with blur-up placeholders. Large datasets are windowed or paginated.

Gated by: `size-limit` bundle budget in CI.

---

## 4. Cross-Platform — one codebase, every device

The app reaches users on Web, Android, and iOS from a single codebase. There is no separate native codebase to maintain.

The current implementation is a Progressive Web App: installable via the browser, offline-capable, and updated through a Service Worker with a versioned precache and an update-prompt flow. The Service Worker is cache-first for all static assets. The app shell is served via Workers Static Assets binding so asset requests are free and do not count against the Worker quota. On iOS, `navigator.storage.persist()` is called on first launch to defend against IndexedDB eviction.

Gated by: Playwright-BDD E2E tests covering offline-to-online flows.

---

## 5. Polished — looks good and feels right

The app is responsive across all screen sizes from mobile to desktop. Layouts are information-dense without excessive whitespace. Cards are tight, content is scannable, and every screen has a clear purpose.

Interactions are optimistic. Buttons respond instantly even before the network confirms. Transitions are smooth and purposeful, never decorative. The app feels native: installable, offline-capable, with a consistent design language. Accessibility is built in, not bolted on — keyboard navigation, focus management, and screen reader support are first-class. Copy is concise and localized for English and Indonesian. Dates, numbers, and currency are formatted via the Intl API for each locale.

Gated by: visual regression tests and accessibility audits in CI.

---

## 6. Secure — defense in depth

Every external boundary is validated. Sessions live in D1 via Better Auth with social OAuth and passkeys. There is no custom crypto. Secrets are injected via `wrangler secret`; nothing sensitive lives in the repository.

Rate limiting is enforced at the edge. Secure headers and CORS locked to known origins are mandatory on all responses. Account deletion cascades across all data stores for GDPR readiness. Payment webhooks verify signatures and are idempotent.

### Security scanning

| Layer | Tool | When |
|---|---|---|
| Static analysis | Semgrep + CodeQL | Every PR |
| Dependency vulnerabilities | OSV-Scanner | Every PR |
| Secret scanning | gitleaks | Every PR |
| Dynamic security scan | OWASP ZAP Baseline | Every main merge against staging |
| API fuzzing | Schemathesis | Every main merge against staging |

---

## 7. Observable — easy to monitor

Every layer emits structured data. Infrastructure metrics come from Cloudflare Analytics. Core Web Vitals and page views come from Cloudflare RUM. Logs are structured JSON with correlation IDs that propagate across client, edge, and database. Errors are tracked via Sentry with graceful degradation when quotas are exhausted.

Gated by: structured log validation and correlation ID tracing in CI.

This is not an afterthought. Observability is a design constraint that shapes how adapters are built and how logs are emitted.

| Layer | Tool |
|---|---|
| Infrastructure metrics | Cloudflare Analytics |
| RUM / Core Web Vitals | Cloudflare Web Analytics |
| Logs | Workers Logs |
| Errors | Sentry |

---

## 8. Maintainable — easy to evolve

Workers are stateless. All external service interactions pass through adapter interfaces in `packages/infra`. Business logic does not import Cloudflare-specific types or access environment bindings directly. The database schema uses only standard SQL for transparent portability to other backends.

The system is designed for migration. Every Cloudflare-specific service is hidden behind an adapter interface. A future move to a VPS requires swapping adapters, not rewriting business logic.

The monorepo is organized by contract. Shared Zod schemas are the single source of truth for client and server. Files are small and focused. Contracts, types, and tests are written before implementation. Schema changes require both server and client migrations. API versions are explicit; breaking changes get a new version, never an in-place break.

Gated by: `vp check` (lint + typecheck) and `vp test` (coverage > 80%) on every PR.

### Versioning and client lifecycle

All API routes are under `/v1/`. The Service Worker uses versioned precache with an update-prompt flow so users are never stranded on stale clients. Client migrations run before the store loads, governed by `SCHEMA_VERSION` in `packages/sync-protocol`.

### Monorepo layout

```
my-app/
├── apps/
│   ├── web/                    # React 19 PWA
│   │   ├── src/routes/         # File-based routes
│   │   ├── src/components/     # shadcn/ui + custom
│   │   ├── src/lib/            # MergeableStore, sync, i18n, migrations
│   │   └── public/             # manifest, icons
│   └── api/                    # Hono RPC Worker
│       ├── src/routes/         # /v1/* route handlers
│       ├── src/lib/            # auth, db, merge, payments, middleware
│       └── wrangler.toml
├── packages/
│   ├── shared-zod/             # Client ↔ server contracts
│   ├── db-schema/              # Drizzle schema + migrations
│   ├── sync-protocol/          # Sync types, SCHEMA_VERSION, merge helpers
│   └── infra/                  # Adapters: ObjectStore, ConfigStore, Cache, JobScheduler, Logger
├── .github/workflows/
│   ├── ci.yml                  # PR gate
│   ├── e2e.yml                 # Playwright-BDD vs wrangler dev
│   ├── staging.yml             # Deploy staging → BDD + DAST + fuzz
│   └── deploy.yml              # Promote staging → production + smoke tests
├── ARCHITECTURE.md             # ← this file
├── AGENTS.md                   # ← normative rules
├── flake.nix                   # reproducible dev shell
└── adr/                        # architecture decision records
```

---

## 9. Available — no downtime

The system degrades gracefully rather than failing hard. On flaky networks, sync retries with exponential backoff and persists pending changes in IndexedDB. When quotas are exhausted, non-critical services like Sentry and email degrade silently rather than crashing the app.

The server is the durable copy. D1 Time Travel provides point-in-time recovery. Daily Cron Triggers export snapshots to R2 with versioning and lifecycle retention. A restore runbook exists and is drilled before launch.

Gated by: staging BDD tests and smoke tests post-deploy.

---

## 10. Reliable — verified before it ships

Quality is designed in, not inspected in. Every contract is defined before implementation. Every sync merge is proven idempotent and commutative through property tests. Every user flow is exercised end-to-end before merge. Every dependency is scanned for vulnerabilities before it enters the codebase.

This means contracts, types, and tests exist before code. Coverage is enforced by a gate. Property tests verify the sync protocol, migrations, and webhook handlers. BDD specs describe user-facing flows including offline-to-online transitions. The bundle size is capped and checked on every PR. A change that breaks a gate cannot reach production.

### Testing requirements

| Layer | Tool | Required when |
|---|---|---|
| Unit | Vitest | All business logic, schemas, store queries |
| Property | fast-check | Sync merge, client migrations, webhook idempotency |
| E2E/BDD | Playwright-BDD | User-facing flows, offline-to-online sync |
| Bundle | size-limit | Every PR |
| API fuzz | Schemathesis | Every main merge against staging |
| DAST | OWASP ZAP Baseline | Every main merge against staging |
| Security | Semgrep + OSV-Scanner | Every PR |

Coverage gate: greater than 80 percent.

Gated by: `vp test` with coverage enforcement; `size-limit` for bundle budget.

---

## 11. Reproducible — same environment everywhere

The development environment is identical on every machine. A new contributor runs one command and has the exact same Bun, Node, Wrangler, and tool versions as every other contributor. There is no "works on my machine."

This means the dev shell is defined declaratively. Dependencies, compilers, and CLI tools are pinned. The CI environment matches the local environment. Onboarding takes minutes, not hours.

Gated by: CI runs in the same environment as local dev; nix flake lockfile is version-controlled.

---

## 12. Agentic — built for autonomous development

The codebase is structured so that any agent can understand and modify any module without reading everything. There is no hidden state, no manual wiring, no tribal knowledge required.

This means files are 300 lines or fewer with 5 or fewer direct dependencies. Each module has a typed contract and a clear boundary. Dependencies are explicit and shallow. File-based routing and convention-over-configuration eliminate boilerplate. The structure is self-describing: the monorepo layout, the adapter interfaces, and the Zod schemas tell you what each piece does without reading the implementation. An agent opening a file knows its inputs, outputs, and dependencies at a glance.

Gated by: lint rules for file size (300 lines max) and dependency count (5 direct deps max); typecheck for contract completeness.

---

## 13. Technology choices

| Layer | Choice | Rationale |
|---|---|---|
| Platform | Cloudflare | Workers, D1, R2, Cron, Static Assets, RUM — unified free tier, single vendor. |
| Edge runtime | Cloudflare Workers | Stateless compute at the edge. Free tier, 10ms CPU/req. |
| API framework | Hono + zod-openapi | One Zod schema produces validation, TS types, and OpenAPI 3.1 spec. |
| Auth | Better Auth | Social OAuth + passkeys. Sessions in D1. |
| ORM | Drizzle | Plain-SQL migrations. Database-agnostic schema. |
| Database | Cloudflare D1 | Free tier, SQLite-compatible. Row-level authorization. |
| Storage | R2 via ObjectStore adapter | Swappable for S3, MinIO, or local filesystem. |
| Config | D1-backed ConfigStore | Feature flags and runtime config. |
| Jobs | Cron Triggers via JobScheduler | Swappable for node-cron in non-Worker environments. |
| Payments | Xendit + Polar MoR | Single adapter interface. Per-transaction fees only. |
| Client state | Tinybase MergeableStore | CRDT merge. Only source of truth. |
| Routing | TanStack Router | File-based, type-safe. |
| Transport | TanStack Query | Retries, dedupe, offline persistence. Not a state layer. |
| UI | shadcn/ui + Tailwind | Owned source, Radix accessibility, build-time only CSS. |
| PWA | vite-plugin-pwa | Service Worker, manifest, precache, update-prompt flow. |
| i18n | Build-time translations | English and Indonesian. Intl API for dates, numbers, currency. |
| Tooling | Vite+ | Unified task runner: dev, build, test, lint, format, typecheck. |
| TypeScript | tsgo | Native TypeScript compiler. Strict mode. |
| Package manager | Bun | Native workspaces. Single lockfile. |
| Dev environment | Nix Flakes | Reproducible shell: identical Bun, Node, Wrangler across all machines. |
| Testing | Vitest + Playwright-BDD + fast-check | Unit, E2E, and property-based testing. |
| Error tracking | Sentry | Client and Worker errors and replays. Degrades past free quota. |
| Log ingestion | Workers Logs | Structured JSON logs via Logger adapter. |
