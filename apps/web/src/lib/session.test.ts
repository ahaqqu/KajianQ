import { describe, expect, it, beforeEach, vi } from "vitest";
import { apiFetch } from "./api";
import {
  clearSession,
  deleteSession,
  loadSession,
  saveSession,
} from "./session";

vi.mock("./api", () => ({ apiFetch: vi.fn() }));
const mockedApiFetch = vi.mocked(apiFetch);

describe("session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  describe("deleteSession", () => {
    it("is a no-op without a session", async () => {
      expect(await deleteSession()).toBe(false);
      expect(mockedApiFetch).not.toHaveBeenCalled();
    });

    it("deletes the account server-side and clears the session", async () => {
      mockedApiFetch.mockResolvedValue(new Response(null, { status: 204 }));
      saveSession({
        userId: "u",
        token: "t".repeat(16),
        expiresAt: Date.now() + 10_000,
      });
      expect(await deleteSession()).toBe(true);
      expect(mockedApiFetch).toHaveBeenCalledWith("/auth/me", {
        method: "DELETE",
        token: "t".repeat(16),
      });
      expect(loadSession()).toBeNull();
    });
  });
});
