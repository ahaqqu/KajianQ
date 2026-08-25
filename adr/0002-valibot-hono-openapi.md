# ADR-0002: Valibot + hono-openapi over Zod + zod-openapi

**Status:** accepted  
**Date:** 2026-07-30

## Context

The template carried triplicated route truth: Hono handlers in `app.ts`, a hand-written `lib/openapi.ts` spec, and a path list in `isApiPath` — free to drift apart. Contracts were Zod schemas in `packages/shared-zod` wired through `@hono/zod-openapi`. Locked decisions D1/D2 of the remediation plan required Valibot to replace Zod and hono-openapi to generate the OpenAPI document, gated on a spike (DP-1) proving the integration worked.

## Decision

- All contracts are Valibot v1 schemas in `packages/contracts` (`@app/contracts`); Zod is removed from the dependency tree.
- `hono-openapi` generates `/openapi.json` from the route definitions that also validate requests (Valibot implements Standard Schema). `lib/openapi.ts` is deleted.
- A route-coverage test asserts the documented route set equals the registered `/v1/*` route set, so doc drift fails CI.

## Spike outcome (DP-1, 2026-07-29): PASS

hono-openapi@1.3.1 + valibot@1.4.2 generated an OpenAPI 3.1 doc with request-body validation, response schemas, and 401/409 error responses; invalid bodies were rejected at runtime. The integration needs `@hono/standard-validator`, `@standard-community/standard-json`, `@standard-community/standard-openapi`, and `@valibot/to-json-schema` installed as runtime peers — app code never imports them; hono-openapi's dist does (the last via dynamic import). They are allowlisted in the `truth` gate with that justification. The pre-decided fallback (stay on Zod 4 with `@hono/zod-openapi`) was not taken.

## Consequences

- One route definition produces handler + validation + OpenAPI doc.
- The rewrite surfaced a latent contract bug: sync requests must accept payload-stripped tombstones (empty title), so `SyncNoteSchema` exists alongside the stricter `NoteSchema`.
- Bundle delta: Valibot shrinks the client footprint relative to Zod (recorded in the WS3a PR).
