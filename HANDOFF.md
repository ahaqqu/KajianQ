# Handoff prompt — KajianQ issues #40, #43, #44, #45, #47, #49, #63

Paste everything below the line into a fresh agent session.

---

## Mission

Tackle GitHub issues **#40, #43, #44, #45, #47, #49, #63** in `ahaqqu/KajianQ`. These were validated against `main` (`9612a8d`) and are all still open/required. Implement them in the grouped PR plan below. Read `AGENTS.md`, `CONTEXT.md`, and the relevant ADRs before writing code.

## Decisions already made by the user

| # | Question | Decision |
|---|---|---|
| #43 | SPA middleware path | Route SPA paths through Hono so `secureHeaders`/CSP/CORS/rate-limit/correlation-id apply, then serve ASSETS from a catch-all handler. |
| #47 | Trailing slashes | Normalize (e.g. `/v1/health/` resolves to `/v1/health`). |
| #45 | `TraceEvent` contract | Strict discriminated union — unknown `kind` fails `v.parse`. |
| #63 item 1 | `RetrievalTrack` / columns | Rename both TS enum and DB columns: `ar`/`id` → `primary`/`fallback`, `embedding_ar`/`embedding_id` → `embedding_primary`/`embedding_fallback`. No backward-compat migration; update the initial schema files directly. |

## PR plan (implement in this order)

### PR A — API middleware / routing hygiene
**Issues:** #40, #43, #47

1. **Thread `RequestContext` through `c.var`** (#40)
   - In `apps/api/src/lib/middleware.ts`, build `createRequestContext(c.env.APP_ENV, correlationId)` once and store it as `c.set("ctx", ctx)`.
   - Extend `ApiEnv` `Variables` to include `ctx: RequestContext`.
   - Update `apps/api/src/lib/errors.ts` to read `c.get("ctx").logger` instead of constructing a new logger.
   - Update `apps/api/src/routes/health.ts` to use `c.get("ctx")` directly.

2. **Route everything through Hono + serve SPA from catch-all** (#43)
   - Change `apps/api/src/index.ts` to send **all** requests into `api.fetch(request, env, ctx)`.
   - In `apps/api/src/app.ts` or `apps/api/src/routes/index.ts`, register a final catch-all after `registerDocRoutes(api)`:
     - If the path starts with `/v1/`, return JSON `404 { error: "not_found" }`.
     - Otherwise, serve the SPA by calling `c.env.ASSETS.fetch(c.req.raw)`.
   - Adjust CSP in `applyMiddleware` if needed for SPA inline styles while keeping restrictive defaults.
   - Update `apps/api/src/app.test.ts` to assert CSP on `/` and a client-side route (e.g., `/chat`).

3. **Normalize trailing slashes** (#47)
   - Enable Hono trailing-slash normalization so `/v1/health/` works.
   - Add tests for `/v1/health/`, `/v1/foo` (JSON 404), and `/` (SPA with CSP).

### PR B — Rate limiter: document + bound memory
**Issue:** #44

1. Add clear comments in `packages/infra/src/rate-limit.ts` and `apps/api/src/lib/rate-limit-mw.ts` stating the memory limiter is single-isolate, non-production, and must be replaced by a global backend (DO/KV) later.
2. Implement bounded memory: add `maxKeys` cap to `createMemoryRateLimiter`, evict oldest when over cap, optionally prune expired windows.
3. Keep the `RateLimiter` interface unchanged.
4. Update `apps/api/src/app.ratelimit.test.ts` if behavior changes.

### PR C — `TraceEvent` strict discriminated union
**Issue:** #45

1. In `packages/contracts/src/trace.ts`:
   - Replace `kind` with a `v.picklist` of concrete kinds: `"llm_call"`, `"retrieval"`, `"subquery"`, `"intent"`, `"refusal"`, `"assembly"`, `"review"`, `"ingest"`, `"eval"`.
   - Replace open `detail: Record<string, unknown>` with a discriminated union via `v.variant` keyed on `kind`.
   - Define typed detail variants for each kind.
   - Keep `cost` and `reason` fields as today.
2. Update any existing `TraceEvent` producers/consumers to the new shape.
3. Add a code comment noting that unknown kinds now fail validation (strict mode per user decision).

### PR D1 — Rename `RetrievalTrack` and DB columns
**Issue:** #63 item 1

Since the user confirmed no migration/backward-compat concern, update the initial schema source-of-truth:

1. In `packages/infra/src/rag-store.ts`:
   - `RetrievalTrack = "primary" | "fallback"`
   - Rename `DocChild.embeddingAr` → `embeddingPrimary`, `embeddingId` → `embeddingFallback` (and `DocChildInsert`).
2. Update initial migration SQL (`packages/infra/migrations/*.sql`):
   - `embedding_ar` → `embedding_primary`
   - `embedding_id` → `embedding_fallback`
3. Update adapter SQL in `rag-store-neon.ts`, `rag-store-neon-query.ts`, `rag-store-shared.ts`.
4. Update tests that construct rows or assert column names.
5. Add a comment explaining `primary`/`fallback` maps to KajianQ’s AR/ID language tracks at the domain-pack layer.

### PR D2 — Remaining #63 cosmetic refactors

Group in dependency order:

1. **Discoverability / tooling**
   - Add `bin` entry to `packages/infra/package.json` pointing at `scripts/db-migrate.mjs`.
   - Move `template-sync.json` `_comment_ci` rationale to `template-sync.notes.md`; keep JSON pure config.

2. **Observability**
   - Accept optional `Logger` in `createNeonRagStore` and log slow queries / errors. Default remains no-op for tests.

3. **Type ergonomics**
   - Introduce `PartialBy<T, K>` helper and preserve `readonly` on `DocChildInsert`/`DocParentInsert` embedding fields.

4. **Decision record**
   - Promote `docs/neon-sizing-issue-4.md` to `adr/0019-neon-dual-vector-sizing.md` (or next available number) and replace the doc with a pointer.

5. **Pluggability polish**
   - Add `createRagStore(provider: 'neon', sql)` factory.
   - Stop exporting `SqlRunner` from `packages/infra/src/index.ts`; keep it internal to the Neon adapter.

6. **Interface decomposition (deferred)**
   - Leave `RagStore` as one interface for now. Only split into `CorpusStore`/`TraceStore`/`ChatStore`/`SessionStore` façade when a second adapter becomes concrete.

## Working agreements (non-negotiable)

- **No `git commit`, push, or PR without explicit approval each time.**
- PR titles/descriptions in English; update via `gh api --input` with a JSON payload file — never `gh pr edit --field body=...`.
- Do not close or modify spec issues (#1, #27). Tick acceptance-criteria checkboxes via `gh api --input` PATCH.
- Technical docs and code in English; UI copy Indonesian-first.
- Run `bun run check && bun run test && bun run boundary && bun run build` before declaring a PR ready.

## Key files involved

- `apps/api/src/index.ts`
- `apps/api/src/app.ts`
- `apps/api/src/lib/middleware.ts`
- `apps/api/src/lib/errors.ts`
- `apps/api/src/lib/context.ts`
- `apps/api/src/routes/health.ts`
- `apps/api/src/routes/index.ts`
- `apps/api/src/routes/docs.ts`
- `apps/api/src/app.test.ts`
- `apps/api/src/app.ratelimit.test.ts`
- `packages/infra/src/rate-limit.ts`
- `apps/api/src/lib/rate-limit-mw.ts`
- `packages/contracts/src/trace.ts`
- `packages/infra/src/rag-store.ts`
- `packages/infra/src/rag-store-neon.ts`
- `packages/infra/src/rag-store-neon-query.ts`
- `packages/infra/src/rag-store-shared.ts`
- `packages/infra/src/index.ts`
- `packages/infra/package.json`
- `packages/infra/migrations/*.sql`
- `template-sync.json`
- `docs/neon-sizing-issue-4.md`
- `.github/workflows/deploy.yml`
- `.github/workflows/staging.yml`

## Verification checklist per PR

- Domain boundary: no Islamic-domain identifiers in engine packages.
- No vendor names in engine/app code outside `packages/infra` Provider adapters and config.
- No direct DB client imports outside RagStore adapter and migrations.
- Any new LLM call records model/tokens/cost to a trace.
- Any new persisted answer path writes a trace record the UI can render.
- Vocabulary matches `CONTEXT.md`.
- `bun run check && bun run test && bun run boundary && bun run build` green.
