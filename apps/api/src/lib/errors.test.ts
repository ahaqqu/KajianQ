import { describe, expect, it } from "vitest";
import { ProviderError, StageError } from "@app/rag-core/interop";
import { Hono } from "hono";
import type { ApiEnv } from "../env";
import { engineErrorStatus, onError } from "./errors";

describe("engineErrorStatus", () => {
  it("maps provider kinds onto honest HTTP statuses", () => {
    expect(
      engineErrorStatus(
        new ProviderError({ kind: "rate_limited", message: "vendor 429" }),
      ),
    ).toBe(429);
    expect(
      engineErrorStatus(new ProviderError({ kind: "bad_request", message: "bad key" })),
    ).toBe(400);
    expect(
      engineErrorStatus(new ProviderError({ kind: "transport", message: "dns" })),
    ).toBe(502);
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

  it("typed engine failures become 429 with an upstream body, not a 500", async () => {
    const res = await app.request("/fail");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "upstream" });
  });
});
