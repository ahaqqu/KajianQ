import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Cloudflare from "alchemy/Cloudflare";
import { localState, Stack, Stage } from "alchemy";

// The single description of the Cloudflare topology (ADR-0028): `alchemy
// deploy` applies this file against the cloud; `alchemy dev` evaluates the
// same file locally on workerd with virtual resources.

// `alchemy dev` sets ALCHEMY_DEV=true in the child that evaluates this file,
// before module load. Dev runs are fully local — workerd, a virtual R2
// bucket, and a local Durable Object — so they use the file-system state
// store and need no cloud credentials. The flag is read synchronously here
// (the state layer is chosen before the stack effect runs), off the ambient
// process object, since this module must typecheck under workers-types.
const env =
  (globalThis as { process?: { env: Record<string, string | undefined> } })
    .process?.env ?? {};
const isDev = env.ALCHEMY_DEV === "true";

// Secrets were applied out-of-band via `wrangler secret` before Alchemy took
// over; declaring them here re-binds them as `secret_text` on deploy, so the
// wrangler-era values are superseded without ever passing through the repo.
// Local runs omit them: the foundation-shell routes never touch providers.
const SENTRY_DSN = Config.redacted("SENTRY_DSN");
const DASHSCOPE_API_KEY = Config.redacted("DASHSCOPE_API_KEY");
const DEEPSEEK_API_KEY = Config.redacted("DEEPSEEK_API_KEY");
const GEMINI_API_KEY = Config.redacted("GEMINI_API_KEY");
const MOONSHOT_API_KEY = Config.redacted("MOONSHOT_API_KEY");

const ASSETS = {
  directory: "../web/dist",
  notFoundHandling: "single-page-application",
  runWorkerFirst: true,
} as const;

const COMPATIBILITY = {
  date: "2025-07-01",
  flags: ["nodejs_compat"],
};

export default Stack(
  "kajianq",
  {
    providers: Cloudflare.providers(),
    state: isDev ? localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    if (isDev) {
      // No physical names: local resources are virtual, keyed by state.
      // Port 8787 matches the vite dev proxy and the Playwright webServer.
      const bucket = yield* Cloudflare.R2.Bucket("raw", { forceDestroy: true });
      const worker = yield* Cloudflare.Worker("api", {
        main: "./src/index.ts",
        compatibility: COMPATIBILITY,
        assets: ASSETS,
        dev: { port: 8787, strictPort: true },
        env: {
          BUCKET: bucket,
          RATE_LIMITER: Cloudflare.DurableObject("RATE_LIMITER", {
            className: "RateLimiterDo",
          }),
          APP_ENV: "development",
          ALLOWED_ORIGINS: "",
        },
      });
      return { url: worker.url ?? null };
    }

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
      compatibility: COMPATIBILITY,
      assets: ASSETS,
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
