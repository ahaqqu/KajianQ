// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp, wrapInRouter } from "./app-test-utils";
import { ChatView } from "./chat/ChatView";
import { MAX_PREFILL_LENGTH } from "../lib/chat-prefill";
import { COLLECTION_AVAILABLE } from "../lib/collections-available";

// React 19 + vitest: mark the environment for act() (testing-library's flushes).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom implements no scrolling at all, while the chat transcript calls
// scrollTo unconditionally — re-stubbed before every test.
beforeEach(() => {
  Element.prototype.scrollTo = () => {};
  // The chat never auto-sends (#175): a global fetch stub that records calls
  // makes "no request on pre-fill" an assertion, not an assumption.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 204 })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const composer = () => screen.getByTestId("composer") as HTMLTextAreaElement;

/**
 * The chat route's `?q=` pre-fill (#175), end to end through the real route
 * tree. The pinned semantics: the param seeds the composer DRAFT on first
 * render, is consumed (stripped) so a refresh cannot re-seed, never
 * auto-sends, and an absent or unusable param leaves the composer untouched.
 * The seed never reaches the chat server contract (ADR-0040).
 */

describe("chat route pre-fill from ?q=", () => {
  it("seeds the composer with the param on first render", async () => {
    await renderApp("/?q=Apa%20yang%20Al-Qur%27an%20katakan%20tentang%20kesabaran%3F");
    expect(composer().value).toBe("Apa yang Al-Qur'an katakan tentang kesabaran?");
  });

  it("never auto-sends: no request is made and no turn is appended", async () => {
    await renderApp("/?q=Apa%20itu%20ayat%20kursi%3F");
    expect(composer().value).toBe("Apa itu ayat kursi?");
    // The draft is present but no turn was sent — the transcript is still the
    // empty state and nothing reached the network.
    expect(screen.queryByTestId("message-user")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("consumes the param — the chat URL is stripped after the seed", async () => {
    const { router } = await renderApp("/?q=Apa%20itu%20ayat%20kursi%3F");
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(router.state.location.href).toBe("/");
    // The seed survives the strip: it lives in state, not in the URL.
    expect(composer().value).toBe("Apa itu ayat kursi?");
  });

  it("does not re-seed when the stripped URL is loaded again (refresh-safe)", async () => {
    const first = await renderApp("/?q=Apa%20itu%20ayat%20kursi%3F");
    await waitFor(() => expect(first.router.state.location.href).toBe("/"));
    cleanup();
    // A refresh of the consumed URL: no `q`, so the composer opens empty.
    await renderApp("/");
    expect(composer().value).toBe("");
  });

  it("leaves the composer untouched without the param", async () => {
    await renderApp("/");
    expect(composer().value).toBe("");
  });

  it("ignores an empty, whitespace or over-long param, never erroring the route", async () => {
    for (const path of [
      "/?q=",
      "/?q=%20%20%20",
      `/?q=${"x".repeat(MAX_PREFILL_LENGTH + 1)}`,
      "/?q=123",
      "/?other=Apa%20itu%20ayat%20kursi%3F",
    ]) {
      cleanup();
      const { router } = await renderApp(path);
      expect(composer().value, path).toBe("");
      expect(router.state.location.pathname, path).toBe("/");
    }
  });

  it("seeds on a client-side navigation from the collection page's ask link", async () => {
    const { router } = await renderApp("/collection");
    const entry = COLLECTION_AVAILABLE[0]!;
    const ask = screen.getAllByTestId("collection-ask")[0]!;
    const question = entry.ask!.id;
    // The affordance is a real, typed router link: its href carries the seed.
    expect(ask.getAttribute("href")).toContain("?q=");
    await act(async () => {
      await router.navigate({ to: "/", search: { q: question } });
    });
    expect(composer().value).toBe(question);
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });
});

/**
 * The composer's half of the pinned semantics: a seed applies only while the
 * draft is still the untouched initial value, so a draft the reader has already
 * edited is never clobbered — including when the seed arrives late (a
 * client-side navigation after mount).
 */
describe("ChatView pre-fill seeding", () => {
  function renderView(prefill?: string) {
    const onSend = vi.fn();
    const view = (value: string | undefined) =>
      createElement(ChatView, {
        locale: "id",
        messages: [],
        busy: false,
        loadingTranscript: false,
        transcriptTruncated: false,
        error: null,
        online: true,
        prefill: value,
        onSend,
        onNewSession: vi.fn(),
      });
    const result = render(wrapInRouter(view(prefill)));
    return {
      onSend,
      // A rerender must re-wrap: the wrapper is what supplies the router
      // context `AppHeader` reads.
      rerender: (value: string | undefined) => result.rerender(wrapInRouter(view(value))),
    };
  }

  it("takes a seed that arrives after mount, once, without sending", () => {
    const { onSend, rerender } = renderView(undefined);
    expect(composer().value).toBe("");
    act(() => rerender("Apa itu ayat kursi?"));
    expect(composer().value).toBe("Apa itu ayat kursi?");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("never clobbers a draft the reader has already edited", () => {
    const { rerender } = renderView(undefined);
    fireEvent.change(composer(), { target: { value: "Pertanyaan saya sendiri" } });
    act(() => rerender("Apa itu ayat kursi?"));
    expect(composer().value).toBe("Pertanyaan saya sendiri");
  });

  it("does not re-apply a seed the composer has already taken", () => {
    const { rerender } = renderView("Apa itu ayat kursi?");
    expect(composer().value).toBe("Apa itu ayat kursi?");
    fireEvent.change(composer(), { target: { value: "" } });
    // The same seed arriving again is not a new seed — the cleared draft stands.
    act(() => rerender("Apa itu ayat kursi?"));
    expect(composer().value).toBe("");
  });

  it("takes a new seed when the draft is still untouched", () => {
    const { rerender } = renderView("Apa itu ayat kursi?");
    act(() => rerender("Hadits tentang kejujuran?"));
    expect(composer().value).toBe("Hadits tentang kejujuran?");
  });
});
