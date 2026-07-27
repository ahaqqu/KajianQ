import { describe, expect, it, vi } from "vitest";
import { requestPersistentStorage } from "./persist";

describe("requestPersistentStorage", () => {
  it("returns false when unsupported", async () => {
    vi.stubGlobal("navigator", {});
    expect(await requestPersistentStorage()).toBe(false);
  });

  it("calls persist", async () => {
    vi.stubGlobal("navigator", {
      storage: { persist: vi.fn().mockResolvedValue(true) },
    });
    expect(await requestPersistentStorage()).toBe(true);
  });
});
