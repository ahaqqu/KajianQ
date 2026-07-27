import { describe, expect, it, vi } from "vitest";
import { fetchHealth } from "./health";

describe("fetchHealth", () => {
  it("parses valid response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: "ok",
          env: "development",
          schemaVersion: 1,
          message: "Hello World",
        }),
      }),
    );
    const result = await fetchHealth();
    expect(result.message).toBe("Hello World");
    vi.unstubAllGlobals();
  });

  it("throws on non-ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    await expect(fetchHealth()).rejects.toThrow("health_http_500");
    vi.unstubAllGlobals();
  });
});
