// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CONSENT_KEY, chatPersistenceAllowed, loadConsent, setConsent } from "./consent";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("the consent record", () => {
  it("reads an unanswered browser as unanswered, not as a refusal", () => {
    expect(loadConsent()).toBeNull();
    expect(chatPersistenceAllowed()).toBe(false);
  });

  it("round-trips both answers and follows them", () => {
    setConsent("store");
    expect(loadConsent()).toBe("store");
    expect(chatPersistenceAllowed()).toBe(true);

    setConsent("session-only");
    expect(loadConsent()).toBe("session-only");
    expect(chatPersistenceAllowed()).toBe(false);
  });

  it("reads a foreign value as unanswered rather than trusting it", () => {
    window.localStorage.setItem(CONSENT_KEY, "yes-please");
    expect(loadConsent()).toBeNull();
    expect(chatPersistenceAllowed()).toBe(false);
  });

  it("keeps the answer for the tab when storage refuses the write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    setConsent("store");
    // Nothing reached storage, but the tab acts on the answer the reader gave.
    expect(chatPersistenceAllowed()).toBe(true);
    expect(loadConsent()).toBe("store");
  });
});
