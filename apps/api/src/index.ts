import * as Sentry from "@sentry/cloudflare";
import {
  createMemoryConfigStore,
  createMemoryObjectStore,
  createR2ObjectStore,
} from "@app/infra";
import { SCHEMA_VERSION } from "@app/local-first";
import { RateLimiterDo } from "@app/rate/durable";
import { createApi } from "./app";
import type { WorkerBindings } from "./env";

export { RateLimiterDo };

const api = createApi();

const handler = {
  async fetch(
    request: Request,
    env: WorkerBindings,
    ctx: unknown,
  ): Promise<Response> {
    // All requests flow through the Hono stack so security headers, CORS,
    // rate limiting, and correlation ids apply to the SPA as well; the
    // catch-all route at the bottom of createApi serves ASSETS for non-API
    // paths. Handler errors are dispatched by the app's typed onError.
    return api.fetch(request, env, ctx as never);
  },

  async scheduled(_event: unknown, env: WorkerBindings): Promise<void> {
    const store = env.BUCKET
      ? createR2ObjectStore(env.BUCKET)
      : createMemoryObjectStore();
    const config = createMemoryConfigStore();
    const stamp = new Date().toISOString();
    await store.put(
      `backups/${stamp}.json`,
      JSON.stringify({
        at: stamp,
        schemaVersion: SCHEMA_VERSION,
        flag: await config.get("backup"),
      }),
    );
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
