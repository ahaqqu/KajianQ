// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initTheme, readStoredTheme, useTheme } from "./theme";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The theme toggle (the reference layout's circular control): `.dark` on
 * <html>, persisted in localStorage under `kajianq.theme`, default light.
 * `initTheme` runs before the first render so a dark preference never
 * flashes the light theme. Storage is stubbed explicitly (a Map) so the
 * persistence contract is exercised deterministically.
 */

function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
  cleanup();
});

describe("theme", () => {
  it("defaults to light with no stored preference", () => {
    stubStorage();
    expect(readStoredTheme()).toBe("light");
  });

  it("reads a stored dark preference", () => {
    stubStorage().set("kajianq.theme", "dark");
    expect(readStoredTheme()).toBe("dark");
  });

  it("initTheme applies .dark to <html> before first paint", () => {
    stubStorage().set("kajianq.theme", "dark");
    initTheme();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("useTheme toggles, applies the class, and persists the choice", () => {
    const store = stubStorage();
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(store.get("kajianq.theme")).toBe("dark");
    act(() => result.current.toggle());
    expect(store.get("kajianq.theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
