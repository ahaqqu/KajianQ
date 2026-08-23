import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api";

function stubFetch() {
  const spy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch", () => {
  it("prefixes the /v1 base path", async () => {
    const spy = stubFetch();
    await apiFetch("/health");
    expect(spy.mock.calls[0]?.[0]).toBe("/v1/health");
  });

  it("always sends a correlation id", async () => {
    const spy = stubFetch();
    await apiFetch("/health");
    const headers = spy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["X-Correlation-Id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("sets Content-Type only when a body is present", async () => {
    const spy = stubFetch();
    await apiFetch("/health");
    let headers = spy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
    await apiFetch("/sync", { method: "POST", body: "{}" });
    headers = spy.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sets Authorization only with a token", async () => {
    const spy = stubFetch();
    await apiFetch("/auth/me", { method: "DELETE", token: "abc" });
    const headers = spy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer abc");
  });

  it("passes method and signal through", async () => {
    const spy = stubFetch();
    const controller = new AbortController();
    await apiFetch("/health", { signal: controller.signal });
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });
});
