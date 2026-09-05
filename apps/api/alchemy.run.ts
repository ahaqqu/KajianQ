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

// One topology description for both modes, so every binding is written
// exactly once. Dev pins the local dev server and leaves resources virtual;
// cloud pins physical names per stage and binds the five secrets.
interface Topology {
  readonly bucketName?: string;
  readonly workerName?: string;
  readonly forceDestroy: boolean;
  readonly appEnv: string;
  readonly withSecrets: boolean;
  readonly dev?: { port: number; strictPort: true };
}

const DEV_TOPOLOGY: Topology = {
  // No physical names: local resources are virtual, keyed by state.
  // Port 8787 matches the vite dev proxy and the Playwright webServer.
  forceDestroy: true,
  appEnv: "development",
  withSecrets: false,
  dev: { port: 8787, strictPort: true },
};

export default Stack(
  "kajianq",
  {
    providers: Cloudflare.providers(),
    state: isDev ? localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    let topology: Topology;
    if (isDev) {
      topology = DEV_TOPOLOGY;
    } else {
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
      topology = {
        bucketName: isProd ? "kajianq-raw" : "kajianq-raw-staging",
        workerName: isProd ? "kajianq-api" : "kajianq-api-staging",
        // Data-bearing (raw source archives, text_raw backups) — never destroyed.
        forceDestroy: false,
        appEnv: isProd ? "production" : "staging",
        withSecrets: true,
      };
    }

    const bucket = yield* Cloudflare.R2.Bucket("raw", {
      ...(topology.bucketName ? { name: topology.bucketName } : {}),
      forceDestroy: topology.forceDestroy,
    });

    const worker = yield* Cloudflare.Worker("api", {
      ...(topology.workerName ? { name: topology.workerName } : {}),
      main: "./src/index.ts",
      compatibility: COMPATIBILITY,
      assets: ASSETS,
      ...(topology.dev ? { dev: topology.dev } : {}),
      env: {
        BUCKET: bucket,
        RATE_LIMITER: Cloudflare.DurableObject("RATE_LIMITER", {
          className: "RateLimiterDo",
        }),
        APP_ENV: topology.appEnv,
        ALLOWED_ORIGINS: "",
        ...(topology.withSecrets
          ? {
              SENTRY_DSN,
              DASHSCOPE_API_KEY,
              DEEPSEEK_API_KEY,
              GEMINI_API_KEY,
              MOONSHOT_API_KEY,
            }
          : {}),
      },
    });

    return { url: worker.url ?? null };
  }),
);
