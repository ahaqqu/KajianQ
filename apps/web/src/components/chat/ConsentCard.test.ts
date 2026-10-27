// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { renderApp } from "../app-test-utils";
import {
  CONSENT_KEY,
  forgetChatState,
  saveStoredSessionId,
  setConsent,
} from "../../lib/chat-store";

/**
 * The card is exercised on the real chat route: it is the page that asks, and
 * its buttons are what a reader presses.
 */
beforeEach(() => {
  window.localStorage.clear();
  forgetChatState();
});

afterEach(() => {
  cleanup();
  forgetChatState();
});

describe("consent card", () => {
  it("asks on a browser that has not answered, and stores the grant", async () => {
    await renderApp("/");
    const card = screen.getByTestId("consent-card");
    expect(card.textContent).toContain("SEBELUM MULAI");

    fireEvent.click(screen.getByTestId("consent-keep"));
    await waitFor(() => expect(screen.queryByTestId("consent-card")).toBeNull());
    expect(window.localStorage.getItem(CONSENT_KEY)).toBe("store");
  });

  it("keeps the conversation already in memory when the reader agrees", async () => {
    // A conversation under way before the question was answered (a new browser
    // asks first, but the grant must not lose what the tab already holds).
    saveStoredSessionId("sess-live");
    await renderApp("/");
    expect(window.localStorage.getItem("kajianq.chat.sessionId")).toBeNull();

    fireEvent.click(screen.getByTestId("consent-keep"));
    await waitFor(() => expect(screen.queryByTestId("consent-card")).toBeNull());
    expect(window.localStorage.getItem("kajianq.chat.sessionId")).toBe("sess-live");
  });

  it("erases what an earlier visit stored when the reader declines", async () => {
    // An earlier visit kept a session; this one has not answered yet.
    window.localStorage.setItem("kajianq.chat.sessionId", "sess-old");
    await renderApp("/");
    expect(screen.getByTestId("consent-card")).toBeTruthy();

    fireEvent.click(screen.getByTestId("consent-decline"));

    await waitFor(() => expect(screen.queryByTestId("consent-card")).toBeNull());
    expect(window.localStorage.getItem("kajianq.chat.sessionId")).toBeNull();
    expect(window.localStorage.getItem(CONSENT_KEY)).toBe("session-only");
  });

  it("hands focus to the composer when the card goes away", async () => {
    await renderApp("/");
    fireEvent.click(screen.getByTestId("consent-decline"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("composer")));
  });

  it("follows another tab's answer without a reload", async () => {
    setConsent("store");
    await renderApp("/");
    expect(screen.queryByTestId("consent-card")).toBeNull();

    // Another tab withdrew: the stored record changed, so this tab asks again.
    window.localStorage.removeItem(CONSENT_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: CONSENT_KEY }));

    await waitFor(() => expect(screen.getByTestId("consent-card")).toBeTruthy());
  });

  it("does not ask again once the answer is recorded", async () => {
    setConsent("session-only");
    await renderApp("/");
    expect(screen.queryByTestId("consent-card")).toBeNull();
  });
});
