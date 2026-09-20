# @app/rate

Self-contained rate limiting for the Hono API: a `RateLimiter` adapter
interface with a bounded in-memory backend.

Post-ADR-0044 the API runs as a single Bun process behind nginx, so
"per-process" and "global for the deployment" are the same set — the
cross-isolate counting a Durable Object backend provided has no meaning with
exactly one isolate. The Durable Object backend and its `cloudflare:workers`
dependency were removed with the Cloudflare serving path; the guarantee that
matters (one counter per key, created once per process) is unchanged, and the
counter is still named by a digest so no raw IP address is held.

This package exists as a reusable workspace package so forked projects can
consume it from `packages/` instead of copy-pasting it from `apps/`. The API
app keeps only the middleware glue.

## Modules

- `rate-limiter.ts` — `RateLimiter` interface, pure `tickFixedWindow` window
  math, bounded `createMemoryRateLimiter` (prunes expired windows, then evicts
  the oldest at capacity), and `fnv1aHex` key hashing.
- `resolve-rate-limiter.ts` — `resolveRateLimiter()` (the process-wide limiter)
  and the `allowRequest` seam (default 120 req/min per key).
- `bypass.ts` — the purpose-locked Ed25519 bypass JWT (ADR-0041): harness
  traffic that must exceed the `/v1` budget without disabling metering.

## Adopting in a forked API

1. Dependency: add `"@app/rate": "workspace:*"` to the API package.
2. Middleware (inside the request path):

   ```ts
   import { allowRequest, fnv1aHex, resolveRateLimiter } from "@app/rate";

   // CF-Connecting-IP is proxy-established (nginx overwrites it from
   // $remote_addr); the digest keeps the raw address out of the limiter.
   const ip = c.req.header("CF-Connecting-IP") ?? "local";
   if (!(await allowRequest(`ip:${fnv1aHex(ip)}`, resolveRateLimiter()))) {
     return c.json({ error: "rate_limited" }, 429);
   }
   ```

The limiter is bounded and per-process. A future scale-out to several API
processes would need a shared counter (a store-backed limiter, or sticky
routing) — recorded as ADR-0044's revisit trigger, not built speculatively.
