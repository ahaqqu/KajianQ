// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "./app-test-utils";
import {
  HISTORY_KEY,
  OPEN_SESSION_EVENT,
  archiveChatSession,
  clearChatHistory,
  loadChatHistory,
} from "../lib/chat-store";

/**
 * The drawer is exercised through the header control that opens it, on a
 * static page: the transcript endpoint is stubbed, the navigation the drawer
 * performs is real (the chat mounts afterwards and rehydrates from the id it
 * stored).
 */
function stubTranscript(status: number) {
  const fetchFn = vi.fn(async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/auth/anonymous")) {
      return Response.json({ userId: "u1", sessionId: "s1", token: "tok-1", expiresAt: 1 });
    }
    if (href.includes("/chat/sessions/")) {
      if (status !== 200) return new Response(null, { status });
      return Response.json({
        sessionId: "s1",
        messages: [
          { id: "m1", role: "user", content: "Apa itu ayat kursi?", createdAt: 1 },
          { id: "m2", role: "assistant", content: "Ayat al-Kursi…", createdAt: 2 },
        ],
        truncated: false,
      });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchFn);
  return fetchFn;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearChatHistory();
});

function openDrawer(): HTMLElement {
  fireEvent.click(screen.getByTestId("history-toggle"));
  return screen.getByTestId("history-drawer");
}

describe("conversation history drawer", () => {
  it("opens from the header control and says how history works when empty", async () => {
    await renderApp("/faq");
    const drawer = openDrawer();
    expect(within(drawer).getByTestId("history-empty")).toBeTruthy();
    expect(drawer.textContent).toContain("Belum ada percakapan");
  });

  it("lists the conversations this browser held, newest first", async () => {
    archiveChatSession({ id: "a", title: "Ayat kursi", locale: "id", startedAt: Date.now() });
    archiveChatSession({ id: "b", title: "Hadits jujur", locale: "id", startedAt: Date.now() });
    await renderApp("/faq");
    const drawer = openDrawer();
    const rows = within(drawer).getAllByTestId("history-entry");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Hadits jujur");
    expect(rows[0]?.textContent).toContain("baru saja");
  });

  it("removes one entry and clears the rest without touching the server", async () => {
    archiveChatSession({ id: "a", title: "Ayat kursi", locale: "id", startedAt: Date.now() });
    archiveChatSession({ id: "b", title: "Hadits jujur", locale: "id", startedAt: Date.now() });
    const fetchFn = stubTranscript(200);
    await renderApp("/faq");
    const drawer = openDrawer();

    const rows = within(drawer).getAllByTestId("history-entry");
    fireEvent.click(within(rows[0]!).getByLabelText("Hapus dari daftar"));
    expect(within(drawer).getAllByTestId("history-entry")).toHaveLength(1);

    fireEvent.click(within(drawer).getByTestId("history-clear"));
    expect(screen.getByTestId("history-empty")).toBeTruthy();
    expect(loadChatHistory()).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("opens a conversation on the chat route: one request, and the chat adopts it", async () => {
    archiveChatSession({ id: "sess-a", title: "Ayat kursi", locale: "id", startedAt: Date.now() });
    const fetchFn = stubTranscript(200);
    const opened = vi.fn();
    window.addEventListener(OPEN_SESSION_EVENT, opened);
    await renderApp("/");
    openDrawer();

    fireEvent.click(screen.getByTestId("history-entry").querySelector("button")!);

    await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    const messages = fetchFn.mock.calls.filter(([url]: [string | URL]) =>
      String(url).includes("/chat/sessions/sess-a/messages"),
    );
    // The mounted chat adopts the drawer's transcript instead of fetching it again.
    expect(messages).toHaveLength(1);
    expect(window.localStorage.getItem("kajianq.chat.sessionId")).toBe("sess-a");
    expect(screen.queryByTestId("history-drawer")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("message-list").textContent).toContain("Ayat al-Kursi"),
    );
    window.removeEventListener(OPEN_SESSION_EVENT, opened);
  });

  it("keeps an expired conversation in the list, marked, instead of opening a blank chat", async () => {
    archiveChatSession({
      id: "sess-gone",
      title: "Ayat kursi",
      locale: "id",
      startedAt: Date.now(),
    });
    stubTranscript(404);
    await renderApp("/faq");
    const drawer = openDrawer();

    fireEvent.click(screen.getByTestId("history-entry").querySelector("button")!);

    await waitFor(() => expect(within(drawer).getByTestId("history-notice")).toBeTruthy());
    expect(within(drawer).getByTestId("history-notice").textContent).toContain(
      "sudah tidak tersedia",
    );
    expect(within(drawer).getByTestId("history-entry").getAttribute("data-expired")).toBe("true");
    expect(within(drawer).getByTestId("history-entry").textContent).toContain("Kedaluwarsa");
    expect(screen.getByTestId("history-drawer")).toBeTruthy();
    expect(window.localStorage.getItem("kajianq.chat.sessionId")).toBeNull();
  });

  it("closes on Escape and on the backdrop", async () => {
    await renderApp("/faq");
    openDrawer();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("history-drawer")).toBeNull());

    openDrawer();
    fireEvent.click(screen.getByTestId("history-close"));
    await waitFor(() => expect(screen.queryByTestId("history-drawer")).toBeNull());
  });

  it("reads a corrupted list as empty rather than crashing the header", async () => {
    window.localStorage.setItem(HISTORY_KEY, "not-json");
    await renderApp("/faq");
    const drawer = openDrawer();
    expect(within(drawer).getByTestId("history-empty")).toBeTruthy();
  });
});
