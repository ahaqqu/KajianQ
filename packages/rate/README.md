# @app/rate

Self-contained rate limiting for Hono-on-Workers APIs: a `RateLimiter`
adapter interface with two backends — a Durable Object (one per key, global
across isolates and POPs, alarm-based eviction) and a bounded in-memory
fallback (local dev / tests only, per-isolate).

This package exists so forked projects inherit the limiter through
`template-sync` (merge path `packages/`) instead of copy-pasting it from
`apps/`. The Worker app keeps only composition-root glue.

## Modules

- `rate-limiter.ts` — `RateLimiter` interface, pure `tickFixedWindow` window
  math (single source of truth for all backends), bounded
  `createMemoryRateLimiter`, `createDurableObjectRateLimiter` adapter,
  `fnv1aHex` key hashing.
- `rate-limiter-do.ts` — `RateLimiterDo`, the SQLite-backed Durable Object
  (exposed as the separate `@app/rate/durable` entrypoint so tooling that runs
  under Node/Bun never pulls `cloudflare:workers` in transitively).
- `resolve-rate-limiter.ts` — `resolveRateLimiter(env)` backend selection
  (DO when the `RATE_LIMITER` binding is present, memory otherwise) and the
  `allowRequest` seam (default 120 req/min per key).

## Adopting in a forked Worker

1. Dependency: add `"@app/rate": "workspace:*"` to the API package.
2. Entrypoint: re-export the class so Wrangler can register it —
   `export { RateLimiterDo } from "@app/rate/durable";`
3. `wrangler.toml`:

   ```toml
   [[durable_objects.bindings]]
   name = "RATE_LIMITER"
   class_name = "RateLimiterDo"

   [[migrations]]
   tag = "v1"
   new_sqlite_classes = ["RateLimiterDo"]
   ```

4. Middleware (inside the request path):

   ```ts
   import { allowRequest, resolveRateLimiter } from "@app/rate";

   const ip = c.req.header("CF-Connecting-IP") ?? "local";
   if (!(await allowRequest(`ip:${ip}`, resolveRateLimiter(c.env)))) {
     return c.json({ error: "rate_limited" }, 429);
   }
   ```

Without the binding (local `vitest`, bindingless dev) the bounded in-memory
fallback is used; it is per-isolate and NOT a global defense. With the
binding, counters are global. Durable Objects are available on the Workers
Free plan; each key's DO self-clears via alarm, so storage stays negligible.

Note: `RateLimiterDo` imports `cloudflare:workers`, which only exists in the
Workers runtime. That is why this package has its own tsconfig (with
`@cloudflare/workers-types`) and is excluded from the root typecheck
umbrella; Node-based vitest runs alias `cloudflare:workers` to
`src/test-utils/durable-object-stub.ts`.