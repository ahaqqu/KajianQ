import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack, Stage } from "alchemy";

// Deployed via `alchemy deploy` (ADR-0028); `wrangler.toml` is the dev/e2e
// counterpart of this file — keep bindings in sync when adding one here.

// Secrets were applied out-of-band via `wrangler secret` before Alchemy took
// over; declaring them here re-binds them as `secret_text` on deploy, so the
// wrangler-era values are superseded without ever passing through the repo.
const SENTRY_DSN = Config.redacted("SENTRY_DSN");
const DASHSCOPE_API_KEY = Config.redacted("DASHSCOPE_API_KEY");
const DEEPSEEK_API_KEY = Config.redacted("DEEPSEEK_API_KEY");
const GEMINI_API_KEY = Config.redacted("GEMINI_API_KEY");
const MOONSHOT_API_KEY = Config.redacted("MOONSHOT_API_KEY");

export default Stack(
  "kajianq",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const stage = yield* Stage;
    // Physical names must match the pre-Alchemy resources so the one-time
    // `--adopt` bootstrap takes them over; any other stage would mint fresh
    // buckets/workers, so it is rejected instead.
    const isProd = stage === "prod";
    if (!isProd && stage !== "staging") {
      return yield* Effect.die(
        new Error(`Unsupported stage "${stage}": use "prod" or "staging"`),
      );
    }

    // Data-bearing (raw source archives, text_raw backups) — never destroyed.
    const bucket = yield* Cloudflare.R2.Bucket("raw", {
      name: isProd ? "kajianq-raw" : "kajianq-raw-staging",
      forceDestroy: false,
    });

    const worker = yield* Cloudflare.Worker("api", {
      name: isProd ? "kajianq-api" : "kajianq-api-staging",
      main: "./src/index.ts",
      compatibility: { date: "2025-07-01", flags: ["nodejs_compat"] },
      assets: {
        directory: "../web/dist",
        notFoundHandling: "single-page-application",
        runWorkerFirst: true,
      },
      env: {
        BUCKET: bucket,
        RATE_LIMITER: Cloudflare.DurableObject("RATE_LIMITER", {
          className: "RateLimiterDo",
        }),
        APP_ENV: isProd ? "production" : "staging",
        ALLOWED_ORIGINS: "",
        SENTRY_DSN,
        DASHSCOPE_API_KEY,
        DEEPSEEK_API_KEY,
        GEMINI_API_KEY,
        MOONSHOT_API_KEY,
      },
    });

    return { url: worker.url ?? null };
  }),
);
