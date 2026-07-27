import { describe, expect, it, beforeEach, vi } from "vitest";
import { clearSession, loadSession, saveSession } from "./session";

describe("session", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
  });

  it("saves and loads", () => {
    saveSession({
      userId: "u",
      token: "t".repeat(16),
      expiresAt: Date.now() + 10_000,
    });
    expect(loadSession()?.userId).toBe("u");
    clearSession();
    expect(loadSession()).toBeNull();
  });

  it("drops expired", () => {
    saveSession({
      userId: "u",
      token: "t".repeat(16),
      expiresAt: Date.now() - 1,
    });
    expect(loadSession()).toBeNull();
  });
});
