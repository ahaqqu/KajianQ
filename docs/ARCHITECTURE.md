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

Gated by: `size-limit` in CI. Quota monitoring remains a manual runbook (`docs/QUOTA.md`) because Cloudflare free-tier analytics do not expose an API that supports an automated CI gate at this time.

---

## 2. Local-first — works without network

The client store is the source of truth. All reads and writes succeed offline. Sync is opportunistic, never blocking. Conflict resolution is automatic and invisible.

This means the sync protocol is event-driven, not polled. Writes are optimistic into the client store and the UI reacts immediately. Changes persist to IndexedDB in the same tick. Batched sync fires on reconnect, foreground, online events, or explicit flush. The edge is stateless: each request carries enough context to merge and persist independently. Conflicts resolve via a per-record LWW-element-set CRDT with tombstones (`packages/local-first`), without user intervention. Writes are stamped against a server-raised clock floor — each sync response carries `serverNow` — so a skewed client clock can neither lose nor win every merge. Deletes write payload-stripped tombstones; after a successful sync, local tombstones older than 30 days are garbage-collected. One elected leader syncs per browser; peers stay consistent via BroadcastChannel without redundant network traffic. Client and server negotiate schema version compatibility; mismatches surface as a visible sync error, not silent failure.

The trade-off is granularity: LWW resolves at the whole record, so two clients editing the same note concurrently keep only one side's record — even when they touched different fields. That is acceptable for single-user data. Adopt a field-level CRDT library (e.g. Automerge, Yjs) when collaborative editing of shared records becomes a requirement.

Gated by: `fast-check` property tests for merge idempotency, commutativity (including exact-timestamp ties), associativity, delete-wins, and GC safety.

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

Gated by: axe accessibility audits in the Playwright-BDD suite (serious/critical violations fail the run).

---

## 6. Secure — defense in depth

Every external boundary is validated. Sessions are anonymous Bearer tokens stored in D1. There is no custom crypto. Secrets are injected via `wrangler secret`; nothing sensitive lives in the repository. Better Auth (social OAuth + passkeys, sessions in D1) is the documented upgrade path for consuming projects.

Rate limiting is enforced at the edge. Secure headers and CORS locked to known origins are mandatory on all responses. Account deletion cascades across all data stores for GDPR readiness. Payment webhooks verify signatures and are idempotent.

### Security scanning

| Layer | Tool | When |
|---|---|---|
| Static analysis | Semgrep | Every PR |
| Dependency vulnerabilities | OSV-Scanner | Every PR |
| Secret scanning | gitleaks | Every PR |
| Dynamic security scan | OWASP ZAP Baseline | Every main merge against staging |
| API fuzzing | Schemathesis | Every main merge against staging |

---

## 7. Observable — easy to monitor

Every layer emits structured data. Infrastructure metrics come from Cloudflare Analytics. Core Web Vitals and page views come from Cloudflare RUM. Logs are structured JSON with correlation IDs that propagate across client, edge, and database. Errors are tracked via Sentry — `@sentry/cloudflare` wrapping the Worker handler, `@sentry/react` in the client — errors-only and DSN-gated: with no DSN the SDKs stay disabled and nothing is captured. Session Replay is opt-in (it would pressure the 200 KB bundle budget).

Gated by: structured-log and correlation-ID tests in CI.

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

The monorepo is organized by contract. Shared Valibot schemas in `packages/contracts` are the single source of truth for client and server, and hono-openapi generates the OpenAPI document from the same route definitions that validate requests. Files are small and focused. Contracts, types, and tests are written before implementation. Schema changes require both server and client migrations. API versions are explicit; breaking changes get a new version, never an in-place break.

Gated by: `bun run check` (typecheck) and `bun run test` (coverage > 80%) on every PR.

### Versioning and client lifecycle

All API routes are under `/v1/`. The Service Worker uses versioned precache with an update-prompt flow so users are never stranded on stale clients. Client migrations run before the store loads, governed by `SCHEMA_VERSION` in `packages/local-first`.

### Monorepo layout

```
.
├── apps/
│   ├── web/                    # React 19 PWA
│   │   ├── src/router.tsx      # Code-based type-safe routes
│   │   ├── src/components/     # UI components
│   │   ├── src/lib/            # Local notes store (IndexedDB), session, i18n
│   │   └── public/             # manifest, icons
│   └── api/                    # Hono Worker (also serves web assets)
│       ├── src/routes/         # /v1/* route handlers + hono-openapi definitions
│       ├── src/lib/            # auth, db, notes-repo, middleware, errors
│       ├── migrations/         # Raw SQL — the single database truth
│       └── wrangler.toml
├── packages/
│   ├── contracts/              # Valibot client ↔ server contracts
│   ├── local-first/            # LWW CRDT, SCHEMA_VERSION, note mapping; /client: sync loop, leader, migrations
│   └── infra/                  # Adapters: Logger, ObjectStore, ConfigStore, RateLimiter
├── .github/workflows/
│   ├── ci.yml                  # PR gate
│   ├── e2e.yml                 # Playwright-BDD vs wrangler dev
│   ├── staging.yml             # Deploy staging → BDD + DAST + fuzz
│   └── deploy.yml              # Promote staging → production + smoke tests
├── docs/ARCHITECTURE.md        # ← this file
├── AGENTS.md                   # ← normative rules
├── flake.nix                   # optional reproducible dev shell
└── adr/                        # architecture decision records
```

---

## 9. Available — no downtime

The system degrades gracefully rather than failing hard. On flaky networks, sync retries with exponential backoff and persists pending changes in IndexedDB. When quotas are exhausted, non-critical services like Sentry and email degrade silently rather than crashing the app.

The server is the durable copy. D1 Time Travel is the point-in-time recovery mechanism, drilled per `docs/RUNBOOK_RESTORE.md`. The daily cron writes a timestamped JSON marker to R2 — a placeholder seam that exercises the ObjectStore adapter end-to-end, not a data export. A real export is a consuming-project decision.

Gated by: post-deploy smoke tests (`staging.yml`, `deploy.yml`) and blocking ZAP/Schemathesis scans against staging.

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
| Security | Semgrep + OSV-Scanner + gitleaks | Every PR |

Coverage gate: greater than 80 percent.

Gated by: `bun run test` with coverage enforcement; `bun run size-limit` for bundle budget.

---

## 11. Reproducible — same environment everywhere

The development environment is identical on every machine. A new contributor runs one command and has the exact same Bun, Wrangler, and tool versions as every other contributor. There is no "works on my machine."

This means the dev shell is defined declaratively. Dependencies, compilers, and CLI tools are pinned. The CI environment matches the local environment. Onboarding takes minutes, not hours.

Gated by: CI runs the same Bun scripts as local dev; `flake.nix` pins the toolchain when Nix is available.

---

## 12. Agentic — built for autonomous development

The codebase is structured so that any agent can understand and modify any module without reading everything. There is no hidden state, no manual wiring, no tribal knowledge required.

This means files are 300 lines or fewer with 5 or fewer direct dependencies. Each module has a typed contract and a clear boundary. Dependencies are explicit and shallow. Convention-over-configuration eliminates boilerplate. The structure is self-describing: the monorepo layout, the adapter interfaces, and the Valibot contracts tell you what each piece does without reading the implementation. An agent opening a file knows its inputs, outputs, and dependencies at a glance.

Gated by: `bun run agentic-limits` (300-line / 5-import caps; exemptions only for tests and `src/index.ts` barrels), `bun run truth` (every dependency has an importer), and typecheck for contract completeness.

---

## 13. Technology choices

| Layer | Choice | Rationale |
|---|---|---|
| Platform | Cloudflare | Workers, D1, R2, Cron, Static Assets, RUM — unified free tier, single vendor. |
| Edge runtime | Cloudflare Workers | Stateless compute at the edge. Free tier, 10ms CPU/req. |
| API framework | Hono + hono-openapi | Valibot (Standard Schema) route definitions produce validation, TS types, and the OpenAPI 3.1 doc. |
| Auth | Anonymous D1 sessions | Bearer token in D1; cascade delete. Better Auth (OAuth/passkeys) is the documented upgrade path. |
| Migrations | Raw SQL (`apps/api/migrations/`) | Single database truth. Standard SQL only — no ORM. |
| Database | Cloudflare D1 | Free tier, SQLite-compatible. Row-level authorization. |
| Storage | R2 via ObjectStore adapter | Swappable for S3, MinIO, or local filesystem. |
| Config | ConfigStore adapter | In-memory implementation ships with the template; a D1-backed store is a consuming-project step. |
| Jobs | Cron Triggers | Daily cron writes via the ObjectStore adapter. |
| Payments | Deferred | Not in the template. When added: Xendit (ID) and/or Polar MoR behind one adapter, per-transaction fees only — see AGENTS.md and the `payment-integration` skill. |
| Client state | Custom LWW CRDT (`@app/local-first`) | Per-record LWW-element-set + tombstones. Only source of truth. |
| Routing | TanStack Router | Code-based route tree, type-safe. |
| Transport | TanStack Query | Retries, dedupe, offline persistence. Not a state layer. |
| UI | shadcn/ui + Tailwind | Owned source, Radix accessibility, build-time only CSS. |
| PWA | vite-plugin-pwa | Service Worker, manifest, precache, update-prompt flow. |
| i18n | Build-time translations | English and Indonesian. Intl API for dates, numbers, currency. |
| Tooling | Bun scripts | `bun run check`/`test`/`build`/`dev` call `tsc`, `vitest`, `vite`, and `wrangler` directly. |
| TypeScript | typescript (strict) | Strict mode. `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. |
| Package manager | Bun | Native workspaces. Single lockfile. |
| Dev environment | Nix Flakes (optional) | Pinned Bun and Wrangler when Nix is available. |
| Testing | Vitest + Playwright-BDD + fast-check | Unit, E2E, and property-based testing. |
| Error tracking | Sentry | Client and Worker errors. Errors-only, DSN-gated; Session Replay opt-in. |
| Log ingestion | Workers Logs | Structured JSON logs via Logger adapter. |

---

## 14. Tooling

Root `package.json` scripts are the single source of truth for gates:

| Script | Purpose |
|---|---|
| `bun run check` | typecheck (root + api + web) |
| `bun run test` | unit + property tests (coverage gate) |
| `bun run size-limit` | bundle budget (&lt;200 KB gzipped JS) |
| `bun run agentic-limits` | file-size / import-count caps |
| `bun run truth` | no dependency without an importer |
| `bun run e2e` | Playwright-BDD against `wrangler dev` |
| `bun run build` | build web + prepare worker |
| `bun run dev` | local worker + web |
| `bun run deploy` | `wrangler deploy` (requires login) |
| `bun run deploy:staging` | deploy `--env staging` |

Scripts call `tsc`, `vitest`, `vite`, and `wrangler` directly — no global tooling required beyond Bun. Repo scripts (`scripts/*.mjs`) run under Bun, so the dev shell needs no Node runtime.

This repo is a **working Hello World**, not a prose scaffold. There is no bootstrap skill — start features with `grill-with-docs` / `guided-implementation`.
