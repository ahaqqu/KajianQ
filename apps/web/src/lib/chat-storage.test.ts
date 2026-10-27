// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { setConsent } from "./consent";
import {
  HISTORY_KEY,
  SESSION_KEY,
  TOKEN_KEY,
  forgetChatState,
  persistChatState,
  storageGet,
  storageRemove,
  storageSet,
} from "./chat-storage";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("the chat storage gate (ADR-0063)", () => {
  it("keeps a write in the tab while no answer has been given", () => {
    storageSet(TOKEN_KEY, "tok");
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(storageGet(TOKEN_KEY)).toBe("tok");
  });

  it("persists once the reader agrees", () => {
    setConsent("store");
    storageSet(SESSION_KEY, "sess");
    expect(window.localStorage.getItem(SESSION_KEY)).toBe("sess");
  });

  it("removes from storage even when it may not keep", () => {
    window.localStorage.setItem(HISTORY_KEY, "[]");
    storageRemove(HISTORY_KEY);
    expect(window.localStorage.getItem(HISTORY_KEY)).toBeNull();
  });

  it("flushes every chat key the tab already holds on a grant", () => {
    storageSet(TOKEN_KEY, "tok");
    storageSet(SESSION_KEY, "sess");
    storageSet(HISTORY_KEY, "[]");
    setConsent("store");
    persistChatState();

    expect(window.localStorage.getItem(TOKEN_KEY)).toBe("tok");
    expect(window.localStorage.getItem(SESSION_KEY)).toBe("sess");
    expect(window.localStorage.getItem(HISTORY_KEY)).toBe("[]");
  });

  it("erases storage on withdrawal while the tab keeps its copy", () => {
    setConsent("store");
    storageSet(TOKEN_KEY, "tok");
    storageSet(HISTORY_KEY, '[{"id":"s1"}]');
    window.localStorage.setItem("kajianq.consent", "store");

    setConsent("session-only");
    forgetChatState();

    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(window.localStorage.getItem(HISTORY_KEY)).toBeNull();
    // The conversation under way stays on screen: the tab still reads it.
    expect(storageGet(TOKEN_KEY)).toBe("tok");
    expect(storageGet(HISTORY_KEY)).toBe('[{"id":"s1"}]');
  });
});
