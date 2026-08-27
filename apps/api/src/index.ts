import * as Sentry from "@sentry/cloudflare";
import { RateLimiterDo } from "@app/rate/durable";
import { createApi } from "./app";
import type { WorkerBindings } from "./env";

// Wrangler registers Durable Object classes re-exported from the entrypoint.
export { RateLimiterDo };

const api = createApi();

const handler = {
  async fetch(
    request: Request,
    env: WorkerBindings,
    ctx: unknown,
  ): Promise<Response> {
    // All requests flow through the Hono stack so CSP, CORS, rate-limit,
    // correlation-id, and the typed error handler apply to the SPA as well.
    // The catch-all route at the bottom of createApi serves ASSETS for
    // non-API paths. Handler errors are dispatched by the app's typed onError.
    return api.fetch(request, env, ctx as never);
  },
};

// Errors-only Sentry. Passthrough when SENTRY_DSN is unset: `enabled: false`
// means the SDK client stays disabled — nothing is captured or sent.
export default Sentry.withSentry(
  (env: WorkerBindings) => ({
    dsn: env.SENTRY_DSN,
    enabled: Boolean(env.SENTRY_DSN),
    environment: env.APP_ENV ?? "development",
    tracesSampleRate: 0,
  }),
  handler,
);
