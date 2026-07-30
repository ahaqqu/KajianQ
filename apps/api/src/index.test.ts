import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { DbUnboundError } from "./lib/db";

const { captureException, withSentry } = vi.hoisted(() => ({
  captureException: vi.fn(),
  withSentry: vi.fn((_opts: unknown, handler: unknown) => handler),
}));

vi.mock("@sentry/cloudflare", () => ({ captureException, withSentry }));

type OptionsFn = (env: Record<string, string>) => Record<string, unknown>;

const env = {
  ASSETS: { fetch: async () => new Response("spa") },
};

beforeEach(() => {
  captureException.mockClear();
});

describe("worker sentry wiring", () => {
  it("disables the SDK when SENTRY_DSN is absent (passthrough)", () => {
    const options = withSentry.mock.calls[0]?.[0] as OptionsFn;
    expect(options({})).toEqual({
      dsn: undefined,
      enabled: false,
      environment: "development",
      tracesSampleRate: 0,
    });
  });

  it("enables errors-only capture when SENTRY_DSN is set", () => {
    const options = withSentry.mock.calls[0]?.[0] as OptionsFn;
    const dsn = "https://key@o0.ingest.sentry.io/1";
    expect(options({ SENTRY_DSN: dsn, APP_ENV: "staging" })).toEqual({
      dsn,
      enabled: true,
      environment: "staging",
      tracesSampleRate: 0,
    });
  });

  it("boots and serves health without a DSN", async () => {
    const res = await worker.fetch(
      new Request("https://x/v1/health"),
      env,
      undefined as never,
    );
    expect(res.status).toBe(200);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("maps DbUnboundError to 503 via the typed onError and captures it", async () => {
    const res = await worker.fetch(
      new Request("https://x/v1/notes"),
      env,
      undefined as never,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "db_unbound" });
    expect(captureException).toHaveBeenCalledOnce();
    expect(captureException.mock.calls[0]?.[0]).toBeInstanceOf(DbUnboundError);
  });

  it("passes non-API paths through to assets", async () => {
    const res = await worker.fetch(
      new Request("https://x/notes"),
      env,
      undefined as never,
    );
    expect(await res.text()).toBe("spa");
  });

  it("scheduled writes a timestamped backup to the bucket", async () => {
    const keys: string[] = [];
    const bucket = {
      put: async (key: string) => {
        keys.push(key);
        return {};
      },
      get: async () => null,
      delete: async () => ({}),
      list: async () => ({ objects: [] }),
    };
    await worker.scheduled?.({} as never, { ...env, BUCKET: bucket });
    expect(keys[0]).toMatch(/^backups\/.+\.json$/);
  });
});
