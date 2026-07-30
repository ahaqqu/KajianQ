# Template Remediation Plan

Origin: thermo-nuclear code-quality review (2026-07-28). The review's core finding: **the template carries two systems — the documented one and the real one** — plus gates that exempt their own violators. This plan deletes the phantom system, hardens the real one, and gives the gates teeth.

## Status

| WS | Title | Status | PR |
|---|---|---|---|
| 1 | Delete the dead layer | [x] complete | [#3](https://github.com/ahaqqu/agentic-project-template/pull/3) |
| 2 | `packages/local-first` — DIY local-first module | [x] complete | [#4](https://github.com/ahaqqu/agentic-project-template/pull/4) |
| 3a | Valibot contracts (`@app/contracts`) | [x] complete | [#5](https://github.com/ahaqqu/agentic-project-template/pull/5) |
| 3b | hono-openapi wiring + route decomposition | [x] complete | [#6](https://github.com/ahaqqu/agentic-project-template/pull/6) |
| 4 | Gates with teeth | [x] complete | [#7](https://github.com/ahaqqu/agentic-project-template/pull/7) |
| 5 | Tests, i18n, accessibility | [x] complete | [#8](https://github.com/ahaqqu/agentic-project-template/pull/8) |
| 6 | Docs sync + template-truth gate | [x] complete | [#9](https://github.com/ahaqqu/agentic-project-template/pull/9) |

## How to use this plan (handoff protocol)

A fresh session executes this plan as follows:

1. Read `AGENTS.md`, `docs/ARCHITECTURE.md`, `CONTEXT.md`, then this file in full.
2. Find the first workstream whose status is `not started`. Do not skip ahead — workstreams are dependency-ordered.
3. Before writing code, confirm the repo is green: `bun install && bun run check && bun run test && bun run e2e`.
4. Execute the workstream's tasks in order, checking boxes **in this file** as you complete them.
5. After every task, run `bun run check && bun run test`. Before marking a workstream done, run its **Verify** block.
6. One PR per workstream, titled `ws<n>: <title>`. Use the `guided-implementation` and `writing-tests` skills per `AGENTS.md`. Update the Status table with the PR link.
7. If a task contradicts reality (files moved, APIs changed), stop and re-verify against the actual code — this plan references file paths as of 2026-07-28.
8. If a **Decision point** is marked, do not proceed past it without resolving it per its instructions.

## Locked decisions

These are already decided. Do not reopen them; implement them.

- **D1 — Valibot replaces Zod** for all contracts. Package `packages/shared-zod` becomes `packages/contracts` (`@app/contracts`). Zod is removed from the dependency tree.
- **D2 — hono-openapi generates the OpenAPI document** from route definitions (via Standard Schema, which Valibot v1 implements). The hand-written `apps/api/src/lib/openapi.ts` is deleted. Risk noted under Decision point DP-1 (WS3a).
- **D3 — DIY local-first, Tinybase removed.** The custom LWW-element-set CRDT is the canonical sync story, consolidated and hardened in a new `packages/local-first` module. `tinybase` and `workbox-window` are deleted from dependencies. ARCHITECTURE.md is rewritten to describe the real system.
- **D4 — Raw SQL + SQL migrations are the single database truth.** `packages/db-schema` (Drizzle) is deleted; its migration moves to `apps/api/migrations/`. The API already uses raw SQL exclusively.
- **D5 — Delete fake/unused adapters rather than wire them. Exception: Sentry is wired for real** (user decision 2026-07-28 — the docs describe the intended end-state for real projects, so the template must demonstrate the real SDK). `ConfigStore.hasEntitlement`, `Cache`, `JobScheduler` are deleted; `packages/infra/src/sentry.ts` is **replaced** with real `@sentry/cloudflare` (Worker) and `@sentry/react` (client) wiring, DSN-gated. `ObjectStore` (R2) stays — it has a real caller (cron backup).
- **D6 — Gates must not be bypassable.** `check-agentic-limits.mjs` loses its violator exemptions; coverage applies to real modules; ZAP/Schemathesis become blocking. Files that currently violate limits are decomposed (WS3b) *before* the gate is tightened (WS4).
- **D7 — Accessibility gate is made real.** `@axe-core/playwright` (already a devDependency) is wired into BDD, making ARCHITECTURE.md §5's claim true.
- **D8 — Payments stay out of the template.** AGENTS.md's Payments section is re-scoped to "applies when payments are added" and points at the `payment-integration` skill.

## Non-goals

- No payments implementation (Xendit/Polar) — deferred per D8.
- No Better Auth / OAuth / passkeys — anonymous D1 sessions remain; the swap path is documented only.
- No new features beyond making documented claims real (Sentry wiring per D5). This plan otherwise only deletes, consolidates, hardens, and tests what exists.

---

## WS1 — Delete the dead layer

**Why first:** every deletion shrinks the surface that later workstreams must migrate. Deleting `NoteInputSchema` here means WS3a never rewrites it.

**Tasks:**

- [x] Remove unused dependencies: `tinybase`, `workbox-window` (`apps/web/package.json`); `@hono/zod-openapi` (`apps/api/package.json`); `brace-expansion` root dep removed; **override kept** — `bun pm why` shows it is still required transitively via `vite-plugin-pwa → workbox-build` (security pin for GHSA-mh99-v99m-4gvg).
- [x] Delete `packages/db-schema/` entirely; move `migrations/0000_init.sql` to `apps/api/migrations/`; update `apps/api/wrangler.toml` migrations path and root `package.json` `db:migrate:local`; remove `@app/db-schema` from `apps/api/package.json`.
- [x] Edit `apps/api/migrations/0000_init.sql`: drop the unused `rate_limits` table (template is pre-production; rewriting the initial migration is acceptable — note it in the WS6 ADR). Document that existing local dev DBs must be reset (delete `.wrangler/state`). *(Documented in the migration header comment + PR description.)*
- [x] Delete `packages/infra/src/cache.ts`, `job-scheduler.ts`; remove their exports from `packages/infra/src/index.ts` and their tests from `adapters.test.ts`.
- [x] Delete `ConfigStore.hasEntitlement` and the `entitlements` Set from `packages/infra/src/config-store.ts`.
- [x] **Wire real Sentry (replaces the fake facade; D5 exception):** *(facade deleted — SDK inlined per the task's "pick the simpler")*
  - Worker: add `@sentry/cloudflare` to `apps/api`; wrap the exported handler with Sentry (e.g. `withSentry`) in `apps/api/src/index.ts`, DSN from `env.SENTRY_DSN`. When the DSN is absent, the wrapper is a documented passthrough — the SDK is not initialized and nothing pretends to capture.
  - Client: add `@sentry/react` to `apps/web`; init in `apps/web/src/main.tsx` (or `lib/sentry.ts`) **only when `VITE_SENTRY_DSN` is set** at build time. Errors-only by default — Session Replay adds ~40 KB gz and would pressure the 200 KB `size-limit` budget; document Replay as opt-in.
  - Rewrite `packages/infra/src/sentry.ts` as the thin real seam (or inline the SDK and delete the facade — pick the simpler; the current fake `captureException`-that-only-logs must not survive).
  - Keep `SENTRY_DSN` in `WorkerBindings`; add `SENTRY_DSN` (via `wrangler secret`, per AGENTS.md) and `VITE_SENTRY_DSN` to `.env.example` and README setup docs.
  - Tests: init/no-init behavior on DSN presence; confirm `bun run size-limit` still passes and record the bundle delta in the PR description.
- [x] Delete deprecated `apps/web/src/lib/store.ts` and `store.test.ts`; remove `apps/web/src/lib/store.ts` from `vitest.config.ts` coverage include.
- [x] Delete `NoteInputSchema` from `packages/shared-zod/src/note.ts` (no `POST /v1/notes` exists; sync is the write path).
- [x] Collapse `SessionSchema`/`AuthResponseSchema` (identical, `packages/shared-zod/src/auth.ts`) into one `AuthResponseSchema`; update importers.
- [x] Deduplicate `R2Like` (`packages/infra/src/object-store.ts`) vs `R2Bucket` (`apps/api/src/cf-types.ts`): `cf-types.ts` imports the type from `@app/infra`; delete the local copy.
- [x] Keep `@axe-core/playwright` (wired in WS5 per D7).

**Verify:** `bun install && bun run check && bun run test && bun run build && bun run e2e` all green. `rg -n "tinybase|workbox|zod-openapi|db-schema|JobScheduler|createMemoryCache|hasEntitlement" --glob '!node_modules' --glob '!bun.lock'` returns nothing. Sentry: `SENTRY_DSN` unset → app boots, no capture; set → events flow (verify manually against a real project once, document in PR).

---

## WS2 — `packages/local-first`: DIY local-first module

**Why:** D3. Consolidates the scattered local-first code into one tested, documented module with honest CRDT semantics. Pure TypeScript, no DOM deps in the server-safe parts (the API imports `merge`/`version` too).

**Tasks:**

- [x] Create `packages/local-first` (`@app/local-first`), absorbing `packages/sync-protocol` (delete it) plus client code moved out of `apps/web/src/lib/`:
  - `version.ts` — `SCHEMA_VERSION`, `CLIENT_VERSION` (from sync-protocol).
  - `merge.ts` — LWW-element-set (from sync-protocol), hardened below.
  - `clock.ts` — **new**: server-bias clock discipline.
  - `tombstones.ts` — **new**: tombstone strip + GC.
  - `note-mapper.ts` — **new**: single `NoteRow ↔ Note` mapper (canonical home; deletes the 4 copies: `apps/api/src/lib/notes-repo.ts:5-13,32-38,60-66`, `apps/web/src/lib/notes-store.ts:55-63,105-123`). *(Also adopted server-side in `notes-repo.ts` here — pre-completes WS3b's "adopt note-mapper" task.)*
  - `leader.ts`, `sync-loop.ts`, `persistence.ts` — moved from `apps/web/src/lib/` (client-only entrypoint, e.g. `@app/local-first/client`). *(`sync-loop` takes `loadState`/`pushPull`/`loadSession` as injected deps — the package must not import back into `apps/web`.)*
  - `migrations.ts` — moved from `apps/web/src/lib/`; `ClientSnapshot` type unified with `NotesState` (they are identical shapes — one type). *(`NotesState` survives, now lives in the package and carries optional `clockFloor`.)*
- [x] **Tie-break fix (CRDT correctness):** in `merge.ts`, `updatedAt` ties currently resolve to the second argument, so `mergeNotes(a,b) ≠ mergeNotes(b,a)` on same-ms writes. Break ties deterministically (e.g., on equal `updatedAt`, keep the row whose serialized payload is lexicographically greater). Behavior unchanged except exact ties. *(Rows also normalize `deleted` on entry — the new idempotency property caught `deleted:false` vs `undefined` representation drift.)*
- [x] **Clock discipline:** `pushPull` currently trusts client `Date.now()`. Add: sync response carries `serverNow`; the client stores `max(Date.now(), serverNow)` as the floor for future `updatedAt` stamps (`clock.ts`). Prevents a slow/fast client clock from losing/winning every merge. *(`SCHEMA_VERSION` not bumped: `clockFloor` is optional/additive, never on the wire; old snapshots load unchanged.)*
- [x] **Tombstones:** on delete, write empty `title`/`body` into the tombstone (stop copying payloads — `apps/web/src/lib/notes-store.ts:82-88`); after a successful `pushPull`, GC tombstones with `updatedAt` older than 30 days (they are server-acknowledged by definition of a successful sync). Document the horizon in the module readme comment.
- [x] **Property tests** (fast-check, extending `merge.prop.test.ts`): idempotent, commutative **including exact-timestamp ties**, associative, delete-wins, GC never resurrects or loses alive rows, mapper round-trip. *(Merge arbitraries use small id/timestamp pools to force ties.)*
- [x] **Unit tests** for `leader.ts`, `sync-loop.ts`, `persistence.ts`, `clock.ts`, `tombstones.ts` (these have zero tests today).
- [x] Remove the impossible-state guard `snap.notes ?? []` in `migrations.ts` (field is non-optional) — or make the parsed type honest if snapshots can genuinely lack it.
- [x] Update `apps/web` and `apps/api` imports (`@app/sync-protocol` → `@app/local-first`); delete `packages/sync-protocol`.

**Verify:** `bun run check && bun run test` green with new property/unit tests; `bun run e2e` green (offline-create scenario exercises the real loop). `rg -n "sync-protocol" --glob '!node_modules' --glob '!bun.lock'` returns nothing.

---

## WS3a — Valibot contracts

**Why:** D1. Mechanical, behavior-preserving swap, kept separate from the hono-openapi rewiring so each PR stays reviewable.

- [x] **Decision point DP-1 (spike, timebox ~1h):** prove `hono-openapi` can generate an OpenAPI 3.1 doc from Hono routes validated with Valibot schemas via Standard Schema, in a scratch file (not committed). It must cover: request-body validation, response schemas, and error responses (401/409). **If it cannot:** stop, record the finding in this plan, and fall back to Zod 4 (keep Zod, wire `@hono/zod-openapi` instead — D1/D2 become "stay on Zod 4"). Do not proceed to WS3a/3b on Valibot without a working spike. *(Outcome 2026-07-29: PASS — hono-openapi@1.3.1 + valibot@1.4.2 generated a 3.1 doc with request-body validation, response schemas, and 401/409 error responses all present; invalid bodies rejected at runtime. Spike needed `@hono/standard-validator`, `@standard-community/standard-json`, `@standard-community/standard-openapi`, `@valibot/to-json-schema` alongside — remember for WS3b. Fallback not taken; D1/D2 proceed as locked.)*
- [x] Rename `packages/shared-zod` → `packages/contracts` (`@app/contracts`); rewrite surviving schemas (`health`, `note`, `sync`, `auth`) in Valibot v1 (`v.object`, `v.pipe(v.string(), v.uuid())`, `v.InferOutput` for types). Keep the package's exported names stable where possible to minimize churn. *(All exported names kept; one addition: `SyncNoteSchema` — sync-request items must accept payload-stripped tombstones with empty titles, which the old `NoteSchema(title: min 1)` rejected. This was a latent WS2 contract bug: delete-then-sync failed request validation. The Valibot rewrite makes the contract match the real client behavior.)*
- [x] Swap runtime parsing: `Schema.parse(...)` → `v.parse(...)` in `apps/api/src/app.ts` and any client-side parsing. *(app.ts ×4, routes/health.ts, apps/web/src/lib/health.ts.)*
- [x] Remove `zod` from all `package.json` files; add `valibot` (pin latest stable v1.x; MIT — free-tier compatible). *(valibot@1.4.2 in `@app/contracts`, `@app/api`, `@app/web`; zod fully removed — `bun pm why zod` finds nothing in the lockfile. The direct `zod` dep in apps/api had zero importers.)*
- [x] Rewrite schema unit tests; add an en/id-independent contract test asserting the sync request/response shapes round-trip through `v.parse`. *(health/note tests rewritten on `v.safeParse`; new `sync.test.ts` covers tombstone-accepting requests, `serverNow`-required responses, and the round-trip contract test.)*
- [x] Update all imports repo-wide; keep `lib/openapi.ts` updated by hand for now (deleted next WS). *(No openapi.ts change needed — it describes routes without schema detail.)*

**Verify:** `bun run check && bun run test && bun run e2e` green; `rg -n "from \"zod\"|@app/shared-zod" --glob '!node_modules' --glob '!bun.lock'` returns nothing; `bun run size-limit` reports the web bundle (note the delta — Valibot should shrink it).

---

## WS3b — hono-openapi wiring + route decomposition

**Why:** D2 + D6-prep. One route definition produces handler, validation, and OpenAPI doc — deleting the triplicated route truth (`app.ts` routes / `lib/openapi.ts` / `isApiPath` list) and decomposing the 13-import `app.ts` under the 5-import cap so WS4 can tighten the gate.

- [x] Split `apps/api/src/app.ts` (119 lines, 13 imports) into `apps/api/src/routes/*.ts` — one module per route (`health.ts`, `auth.ts`, `notes.ts`, `sync.ts`), each wiring its own hono-openapi route definition. `app.ts` becomes composition + middleware only (≤5 imports target; middleware may be extracted to `lib/middleware.ts` if needed). *(Done: app.ts is now 17 lines, 5 imports — Hono, ApiEnv, `lib/errors` (onError), `lib/middleware` (secure-headers/CORS/correlation+rate-limit), `routes` (barrel). Route modules are sub-apps via `newRouter()` (`lib/guard.ts`), mounted by `routes/index.ts`; verified against Hono 4.12 internals that `app.route("/", sub)` preserves handlers so hono-openapi metadata survives mounting.)*
- [x] Wire `hono-openapi`: serve the generated doc at `/openapi.json`; **delete `apps/api/src/lib/openapi.ts`** and its test. (`isApiPath` in `apps/api/src/index.ts:13-19` is already a prefix rule, not a route list — no change needed; just verify `/openapi.json` and `/docs` still resolve after the swap.) *(Deps per DP-1 spike: `hono-openapi@1.3.1` + `@hono/standard-validator`, `@standard-community/standard-json`, `@standard-community/standard-openapi`, `@valibot/to-json-schema` — all MIT, pinned. Generated doc carries full JSON Schemas for every 200 response + the sync request body; `valibot` removed from `apps/api` deps (no direct importer left). `/docs` + `/openapi.json` verified live against `wrangler dev`.)*
- [x] Add a route-coverage test: every route registered on the Hono app appears in the generated OpenAPI doc (prevents doc drift permanently). *(`app.test.ts` asserts bidirectional equality: documented method+path set === registered `/v1/*` set, plus DP-1 criteria (sync request body, 200 schema, 401/409 present).)*
- [x] Extract the CORS callback (`app.ts:33-45`, four nested fallbacks) into a pure `resolveCorsOrigin(origin, requestUrl, allowlist)` in `lib/` with unit tests covering: no origin, allowlisted origin, same-host origin, disallowed origin. *(In `lib/cors.ts` with `corsGuard`; tests cover the four planned cases + empty-allowlist `*` + malformed-URL catch.)*
- [x] Replace stringly error dispatch (`index.ts:33`, `err.message === "db_unbound"`) with a typed error (`class DbUnboundError extends Error` in `lib/db.ts`) matched by `instanceof`. *(Plan-vs-code discrepancy resolved per rule 7: WS1's pinned test proved Hono's default onError swallows handler throws, so `index.ts`'s catch — and any `instanceof` there — was unreachable dead code. The typed dispatch therefore lives in `api.onError` (`lib/errors.ts`), which also wires `Sentry.captureException` for route errors (the pinned test's name anticipated exactly this). `index.ts` is now a clean pass-through. DbUnboundError → 503; anything else → 500 + structured log with correlation id.)*
- [x] Adopt the WS2 `note-mapper` server-side; delete the remaining copies in `notes-repo.ts`. *(Verified pre-completed by WS2 per its own annotation: `notes-repo.ts` maps exclusively via `dbToRow`/`noteToRow`/`rowToNote` from `@app/local-first`; repo-wide grep shows no surviving copies.)*
- [x] Shared web API client: new `apps/web/src/lib/api.ts` — one fetch wrapper owning base path, `Authorization: Bearer`, JSON headers, and `X-Correlation-Id` propagation. Refactor `health.ts`, `session.ts`, `notes-store.ts` (via local-first module), `NotesPage.tsx` to use it. Deletes 4 copies of header/URL boilerplate. *(`apiFetch` owns the `/v1` prefix, per-request correlation id, bearer, and conditional JSON content-type; unit-tested. Also hardened the boundary: `ensureSession`/`pushPull` now `v.parse` their responses (`AuthResponseSchema`/`SyncResponseSchema`) instead of casting. Behavior notes: invalid sync bodies now get 400 from the validator middleware (previously 500 from a thrown ValiError), and auth is checked before body validation (401 takes precedence over 400) — both pinned by tests. Server-side response `v.parse` self-assertions were dropped: hono-openapi now owns response-schema truth, and WS3a's contract round-trip tests cover the shapes.)*

**Verify:** `bun run check && bun run test && bun run e2e` green; `curl $STAGING/openapi.json` (or dev) matches real routes — the route-coverage test enforces this in CI; Schemathesis fuzz (WS5 makes it blocking) runs against the generated doc.

---

## WS4 — Gates with teeth

**Why:** D6. Done after WS2/WS3 so the newly-compliant code passes the tightened gates. A gate that can't fail is a no-op that costs CI time and credibility.

- [x] `scripts/check-agentic-limits.mjs`: remove exemptions for `src/app.ts`, `router.tsx`, `main.tsx`, and `components/*.tsx` (keep test-file and `index.ts`-barrel exemptions). Confirm every previously-exempt file now passes (app.ts decomposed in WS3b; `NotesPage.tsx` refactored below; `main.tsx`/`router.tsx` slimmed below). *(Done: all four exemption clauses deleted; only test files and `src/index.ts` barrels remain exempt. Verified passers: `app.ts` 5 imports (WS3b), `router.tsx` exactly 5, `main.tsx` 5 after slimming, `HomePage.tsx` exactly 5, decomposed `NotesPage.tsx` 5 + new components ≤4. Gate proven to bite: a deliberate 6th import in `HomePage.tsx` fails with exit 1 — reverted after proving.)*
- [x] Slim `apps/web/src/main.tsx` (7 imports): extract the service-worker update prompt into `lib/sw-update.ts` (also the i18n fix, WS5 — coordinate so this file ends ≤5 imports). *(Done: main.tsx 7→5 counted imports. Two plan-vs-code notes per rule 7: (1) the prompt lives in `lib/sw-update.tsx`, not `.ts` — TypeScript requires `.tsx` for JSX; (2) a composition root `app.tsx` (4 imports) now owns QueryClient/providers, since the prompt extraction alone left main.tsx at 7. `requestPersistentStorage()` moved from a post-mount `useEffect` to bootstrap module scope — idempotent, and ARCHITECTURE §4 specifies "on first launch". WS5 coordination: the i18n fix for the prompt's copy lands in `sw-update.tsx`; main.tsx stays at 5.)*
- [x] Decompose `apps/web/src/components/NotesPage.tsx` (8 imports): extract sync-status badge into its own component; use the shared `api.ts` client (WS3b). *(Done — reality was 9 imports, not 8 (WS3b added `lib/api`): NotesPage now 5. Extracted `SyncStatusBadge` (nested ternary preserved verbatim — WS5 replaces it with the status→label map + `syncError` keys), `NotesHeader` (badge + sign-out), `NoteForm`, `NoteList`, and a `use-notes.ts` controller hook owning state/sync-loop/actions (5 imports). New `deleteSession()` in `lib/session.ts` (unit-tested) owns the account-delete call so the hook stays at 5; `wipe` preserves the exact no-session no-op semantics. All `data-testid`s unchanged; e2e green. The shared `api.ts` client was already adopted by WS3b.)*
- [x] `vitest.config.ts` coverage: replace the curated include list with `packages/**/src/**/*.ts`, `apps/api/src/**/*.ts`, `apps/web/src/lib/**/*.ts`; exclude only `**/index.ts`, `**/*.d.ts`, entry bootstraps (`main.tsx`), and `components/**` — with a comment stating the policy: *unit coverage for logic; UI covered by Playwright-BDD + axe*. Thresholds stay 80/80/70/80 and must now honestly pass (WS2 added the local-first tests). *(Done — but not honestly-passing on its own: broadening surfaced `apps/web/src/lib/notes-store.ts` at 0%, dragging functions to 80.34% vs the 80 threshold (0.34% margin — one uncovered function from failing). Added `notes-store.test.ts`: in-memory IndexedDB fake + `apiFetch` mocked at the adapter seam; covers IDB round-trip, clock-floor stamping, payload-stripped tombstones, the sync wire shape, 409/500/invalid-body paths, merge + clock-floor raise + tombstone GC + persistence. Result: notes-store.ts 93.6% stmts/100% lines; totals 92.97/88.81/92.3/95.37 vs thresholds 80/70/80/80. Test-file exclusion retained alongside the plan's exclude list — obvious necessity, since tests live under `src/`.)*
- [x] `.github/workflows/staging.yml`: remove `continue-on-error: true` (ZAP) and `|| true` (Schemathesis). Triage any findings that surface; suppressions require an inline comment with justification. *(Done: both bypasses removed; a comment records the D6 policy (gate failure fails the workflow; suppressions only via an inline rule file with justification). The workflow is `workflow_dispatch`-only against live staging, so finding-triage happens on the next staging run — none could surface locally. YAML re-validated.)*

**Verify:** `bun run agentic-limits` passes with the reduced exemption list; `bun run test --coverage` passes with the broadened include; a deliberately-added 6th import in a random file fails CI (revert after proving).

---

## WS5 — Tests, i18n, accessibility

- [x] HTTP-layer route tests through `createApi()` (`app.request(...)`) with `vi.mock`'d repo/auth boundaries: `/v1/sync` 409 schema-mismatch, 429 rate-limit, CORS callback matrix (via WS3b's pure function + one integration smoke), `DELETE /v1/auth/me` 204/401, `POST /v1/auth/anonymous` happy path. These paths are untested today. *(Plan-vs-reality per rule 7: WS3b's `app.test.ts` already covers the 409, DELETE 204/401, anonymous-auth, and CORS integration-smoke paths, and `cors.test.ts` covers the pure-function matrix — only the **429 branch** (`middleware.ts:17`) was genuinely untested. New `apps/api/src/app.ratelimit.test.ts` drives the **real** limiter to exhaustion through the full middleware stack (120×200 → 429 `rate_limited`, correlation id still set) — no mock, so it proves the wiring, not just the mapping. Coupled to the 120/min constant by design, noted in the file.)*
- [x] Replace `sql.includes(...)` substring fakes in `auth.test.ts`/`notes-repo.test.ts` with a structured in-memory D1 fake (match normalized statements), or bound the fragility with a comment + one integration-style test per repo. *(Structured fake chosen: shared `apps/api/src/lib/memory-d1.ts` matches whitespace-normalized statements **exactly** and throws on unknown SQL (fail-loud on query drift). It models the notes upsert's per-user `WHERE notes.user_id` guard — the old substring fake silently allowed cross-user overwrites; the new `notes-repo` cross-user test would have failed under the old fake. Also pinned: upsert update path, unknown-statement throw, expired session, empty/unknown bearer token, cascade verified via notes `SELECT`. `auth.ts` and `memory-d1.ts` now 100% lines.)*
- [x] i18n breaches: `main.tsx:46` uses the existing unused `t(locale, "updateAvailable")`/`"reload"` keys (locale sourced the same way `router.tsx` sources it); `HomePage.tsx:43` bare `time` gets a key (en+id). Add a key-parity test: `messages.en` and `messages.id` have identical key sets. *(Prompt had moved to `lib/sw-update.tsx` per WS4, so the fix landed there. To render the prompt inside the locale provider without breaking router.tsx's 5-import cap: `LocaleCtx`/`useLocale` moved into `lib/i18n.ts`, and the shell extracted to `components/Shell.tsx` (4 imports), which also keeps `document.documentElement.lang` in sync with the locale. `app.tsx` drops the prompt (3 imports), `router.tsx` stays at 5. `HomePage` `time` → `t(locale, "time")` (en "Time" / id "Waktu"); key-parity test added; `messages` exported for it.)*
- [x] Fix `NotesPage.tsx:84-88`: replace nested ternary with a status→label map; render the `error` sync state distinctly (it currently renders as "Synced"); add `syncError` keys (en+id). *(The ternary lived in `SyncStatusBadge.tsx` after WS4's extraction — replaced there with `LABELS: Record<SyncStatus, MessageKey>`; `error` gets the new `syncError` key and amber styling. Copy is truthful: the sync loop retries with backoff on error.)*
- [x] Wire `@axe-core/playwright` (D7): axe scan in the notes BDD suite for home + notes pages; fail on serious/critical violations. *(Wired — and it bit on first run: two real findings fixed. (1) `text-slate-500` on slate-950 ≈ 4.25:1 < 4.5:1 AA → bumped to slate-400 (HomePage `dt`s, NoteList empty state). (2) Button class-override conflict: `bg-slate-700`/`text-slate-100` fought the base `bg-sky-500`/`text-slate-950` (CSS source order picked the failing pair) → `Button` gained a `variant` prop (primary/muted/danger), call sites updated. Failure output now includes target selectors for triage.)*
- [x] BDD: add a scenario switching language to Bahasa Indonesia and asserting rendered `id` copy (no test exercises the `id` locale today). *(Scenario selects `id` via `locale-select` and asserts the rendered `Halo Dunia` h1.)*

**Verify:** `bun run test --coverage` green; `bun run e2e` green including new scenarios; route tests fail when the 409/429 branches are temporarily broken (prove they bite, revert). *(All green: 141 unit tests, coverage 94.16/90.24/92.64/95.83 vs 80/70/80/80 thresholds; 7/7 e2e including the id-locale and both axe scenarios; `size-limit` 128.52 kB < 200 kB; `agentic-limits` OK. Bite-proof: 409 branch disabled → `app.test.ts` 409 test failed → reverted; 429 branch disabled → `app.ratelimit.test.ts` failed → reverted.)*

---

## WS6 — Docs sync + template-truth gate

**Why:** the review's root cause — nothing kept docs, deps, gates, and code in sync, and the drift gets cloned into every fork. This WS makes the docs true and adds a standing check.

- [x] `docs/ARCHITECTURE.md` updates:
  - [x] §2/§13: sync = custom LWW-element-set CRDT, per-record, in `packages/local-first`; remove Tinybase claims; document clock discipline + tombstone GC horizon; note the same-record-concurrent-edit limitation (wholesale LWW) and when to adopt a real CRDT library.
  - [x] §6: auth = anonymous D1 sessions; Better Auth (OAuth/passkeys) documented as the consuming-project upgrade path.
  - [x] §7: verify the prose matches the **real** Sentry wiring from WS1 (user decision 2026-07-28: Sentry stays in docs; template demonstrates the real SDK). An earlier demotion of Sentry to "deferred" was reverted the same day.
  - [x] §13: Valibot + hono-openapi row (replace "Hono + zod-openapi"); remove Drizzle row (raw SQL + migrations); remove Better Auth row (mark as future path).
  - [x] §9: reconcile the backup claim — the cron handler (`index.ts:42-56`) writes a timestamp JSON to R2, **not** a D1 snapshot. Either make the claim truthful (D1 Time Travel via `docs/RUNBOOK_RESTORE.md` is the real recovery mechanism; the cron is a placeholder seam for consuming projects) or implement a real export. Prefer the honest doc.
  - [x] §1 + testing table: every gate listed must exist and be blocking (verify one by one).
- [x] `AGENTS.md` updates: `packages/shared-zod` → `packages/contracts` references; re-scope the Payments section (D8); add to Definition of Done: *"No dependency without an importer; no adapter without a production caller; every gate blocking; every doc claim has code."*
- [x] `CONTEXT.md`, `README.md`: update stack tables (Valibot, `@app/local-first`, removed packages).
- [x] ADRs in `adr/`: (1) Valibot + hono-openapi over Zod + zod-openapi (incl. DP-1 spike outcome); (2) DIY LWW CRDT over Tinybase (incl. limitations + adoption trigger); (3) initial-migration edit for `rate_limits` removal.
- [x] New gate `scripts/check-template-truth.mjs` + `bun run truth` + CI wiring: fail if any dependency in any `package.json` has zero imports in source (allowlist: build-time tooling with a comment). Runs in `ci.yml` after `agentic-limits`.
- [x] Mark all Status rows complete; delete nothing in this file — it is the audit trail.

**Verify:** `bun run truth` passes; a newly-added unused dep fails CI (prove, revert); read ARCHITECTURE.md end-to-end — every claim now has code or a gate behind it.

---

## Global definition of done (all workstreams)

- [ ] `bun run check && bun run test && bun run size-limit && bun run agentic-limits && bun run truth && bun run e2e` green on `main`.
- [ ] Zero dead dependencies (`truth` gate), zero test-only adapters, zero non-blocking CI gates.
- [ ] One source of truth each for: DB schema (SQL migrations), routes/OpenAPI (hono-openapi definitions), note mapping (`note-mapper.ts`), client API access (`api.ts`).
- [ ] `mergeNotes` property-tested for idempotency, commutativity (incl. ties), associativity.
- [ ] ARCHITECTURE.md contains no claim without code or a gate behind it.

## Risks

| Risk | Mitigation |
|---|---|
| `@sentry/react` bundle cost (~25 KB gz errors-only) pressures the 200 KB budget | Errors-only default; Replay opt-in; measure delta in WS1 and record in PR |
| hono-openapi/Valibot integration immature | DP-1 spike gates WS3a; fallback to Zod 4 is pre-decided |
| WS2 moves break the offline BDD scenario | Run `bun run e2e` before marking WS2 done; move files before changing behavior |
| Tightened gates block merges mid-plan | WS4 is sequenced after the refactors that create compliance; tighten and verify in the same PR |
| Migration edit breaks existing dev DBs | Template is pre-production; WS1 documents `.wrangler/state` reset |
