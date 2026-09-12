import * as Sentry from "@sentry/cloudflare";
import { RateLimiterDo } from "@app/rate/durable";
import { createLogger } from "@app/infra";
import { createApi } from "./app";
import { cleanupExpiredSessions } from "./lib/scheduled";
import type { WorkerBindings } from "./env";

// The Durable Object class must be re-exported from the entrypoint; Alchemy
// derives the namespace registration from the script's exports (ADR-0028).
export { RateLimiterDo };

const api = createApi();

const handler = {
  async fetch(request: Request, env: WorkerBindings, ctx: unknown): Promise<Response> {
    // All requests flow through the Hono stack so CSP, CORS, rate-limit,
    // correlation-id, and the typed error handler apply to the SPA as well.
    // The catch-all route at the bottom of createApi serves ASSETS for
    // non-API paths. Handler errors are dispatched by the app's typed onError.
    return api.fetch(request, env, ctx as never);
  },

  /**
   * Cron trigger (ADR-0017, ticket #10): reclaim expired anonymous sessions.
   * The schedule is declared in `alchemy.run.ts` (`crons` on the Worker);
   * this handler is what Cloudflare invokes. `ctx.waitUntil` keeps the
   * invocation alive until the cleanup settles, so a slow Neon round-trip is
   * not cut short when the handler returns.
   *
   * The settled result is logged here (thermo-review A7) as well as inside the
   * cleanup: Cloudflare marks the invocation succeeded the moment the handler
   * returns, so without a handler-level completion line a promise that never
   * settles leaves no cron-visible signal at all.
   */
  async scheduled(
    controller: { cron?: string; scheduledTime?: number },
    env: WorkerBindings,
    ctx: { waitUntil?: (p: Promise<unknown>) => void },
  ): Promise<void> {
    const logger = createLogger({ service: "api", route: "scheduled" });
    const run = cleanupExpiredSessions(env as unknown as Record<string, string | undefined>).then(
      (result) => {
        logger.debug("scheduled.done", { deleted: result.deleted, ok: result.ok });
        return result;
      },
    );
    if (ctx?.waitUntil) {
      // Round-3 A3: a promise handed to `waitUntil` must not reject unhandled —
      // a non-`ChatConfigError` store fault would vanish into the runtime with
      // no completion line. The rejection is logged here and then swallowed on
      // this path only; the `await` path below still propagates it.
      ctx.waitUntil(
        run.catch((err: unknown) => {
          logger.error("scheduled.failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      );
      return;
    }
    await run;
  },
};

// Errors-only Sentry. Passthrough when SENTRY_DSN is unset: `enabled: false`
// means the SDK client stays disabled — nothing is captured or sent.
// `withSentry` instruments both the `fetch` and `scheduled` handlers.
export default Sentry.withSentry(
  (env: WorkerBindings) => ({
    dsn: env.SENTRY_DSN,
    enabled: Boolean(env.SENTRY_DSN),
    environment: env.APP_ENV ?? "development",
    tracesSampleRate: 0,
  }),
  handler,
);
