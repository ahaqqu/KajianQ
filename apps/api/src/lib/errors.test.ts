import { beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineAbortedError, ProviderError, StageError } from "@app/rag-core/interop";
import { Hono } from "hono";
import type { ApiEnv } from "../env";
import { engineErrorStatus, onError } from "./errors";

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock("@sentry/cloudflare", () => ({ captureException }));

/** Minimal env for hono's `app.request` (ApiEnv bindings are optional). */
const env = { APP_ENV: "test" };

beforeEach(() => {
  captureException.mockClear();
});

describe("engineErrorStatus", () => {
  it("maps provider kinds onto honest upstream-fault statuses", () => {
    expect(
      engineErrorStatus(new ProviderError({ kind: "rate_limited", message: "vendor 429" })),
    ).toBe(429);
    // A vendor 4xx (bad key, malformed vendor call) is OUR misconfiguration,
    // never evidence of a client mistake — 502, not 400.
    expect(engineErrorStatus(new ProviderError({ kind: "bad_request", message: "bad key" }))).toBe(
      502,
    );
    expect(engineErrorStatus(new ProviderError({ kind: "transport", message: "dns" }))).toBe(502);
    expect(
      engineErrorStatus(
        new ProviderError({
          kind: "exhausted",
          message: "all failed",
          candidates: ["a", "b"],
        }),
      ),
    ).toBe(502);
  });

  it("unwraps a StageError down to its ProviderError cause", () => {
    const err = new StageError({
      stage: "generator",
      cause: new ProviderError({ kind: "rate_limited", message: "429" }),
    });
    expect(engineErrorStatus(err)).toBe(429);
  });

  it("returns undefined for non-engine errors and engine errors without a provider cause", () => {
    expect(engineErrorStatus(new Error("boom"))).toBeUndefined();
    expect(
      engineErrorStatus(new StageError({ stage: "router", cause: new Error("internal") })),
    ).toBeUndefined();
    expect(engineErrorStatus(undefined)).toBeUndefined();
  });
});

describe("onError with engine errors", () => {
  const app = new Hono<ApiEnv>().onError(onError).get("/fail", () => {
    throw new ProviderError({ kind: "rate_limited", message: "vendor throttled" });
  });

  it("typed engine failures become 429 with a truthful body and Retry-After", async () => {
    const res = await app.request("/fail", {}, env);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("expected operational kinds are logged, not captured as Sentry exceptions (B3)", async () => {
    await app.request("/fail", {}, env);
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe("onError Sentry filtering", () => {
  function appThrowing(err: unknown) {
    return new Hono<ApiEnv>().onError(onError).get("/fail", () => {
      throw err;
    });
  }

  it("still captures exhausted chains and non-engine defects", async () => {
    await appThrowing(
      new ProviderError({ kind: "exhausted", message: "all failed", candidates: ["a"] }),
    ).request("/fail", {}, env);
    await appThrowing(new Error("boom")).request("/fail", {}, env);
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it("does not capture client aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await appThrowing(new PipelineAbortedError({ signal: controller.signal })).request(
      "/fail",
      {},
      env,
    );
    expect(captureException).not.toHaveBeenCalled();
    expect(res.status).toBe(499);
    expect(await res.json()).toEqual({ error: "aborted" });
  });
});
