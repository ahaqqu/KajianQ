// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHAT_MESSAGE_MAX_LENGTH } from "@app/contracts";
import { wrapInRouter } from "../app-test-utils";
import { ChatView } from "./ChatView";

// React 19 + vitest: mark the environment for act() (testing-library's flushes).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom implements no scrolling: the transcript's auto-scroll effect needs a no-op.
beforeAll(() => {
  Element.prototype.scrollTo = () => {};
});
afterAll(() => {
  delete (Element.prototype as { scrollTo?: () => void }).scrollTo;
});
afterEach(cleanup);

/**
 * The composer's submit ordering (thermo-review A1, #147): the busy and
 * transcript-rehydration guards must run *before* the draft is cleared, as
 * before the submit/sendText split — otherwise Enter during an in-flight
 * turn silently discards the draft (the send button is disabled, but Enter
 * bypasses it), a message the user cannot recover.
 */

function renderView(overrides: {
  busy?: boolean;
  loadingTranscript?: boolean;
  onSend?: (text: string) => void;
}) {
  const onSend = overrides.onSend ?? vi.fn();
  render(
    wrapInRouter(
      createElement(ChatView, {
        locale: "id",
        messages: [],
        busy: overrides.busy ?? false,
        loadingTranscript: overrides.loadingTranscript ?? false,
        transcriptTruncated: false,
        error: null,
        online: true,
        onSend,
        onNewSession: vi.fn(),
      }),
    ),
  );
  return { onSend };
}

function typeDraft(text: string) {
  const composer = screen.getByTestId("composer") as HTMLTextAreaElement;
  fireEvent.change(composer, { target: { value: text } });
  return composer;
}

describe("ChatView submit ordering (thermo-review A1)", () => {
  it("Enter while a turn is in flight preserves the draft and sends nothing", () => {
    const { onSend } = renderView({ busy: true });
    const composer = typeDraft("Tentang niat dalam beramal");
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(composer.value).toBe("Tentang niat dalam beramal");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Enter during transcript rehydration preserves the draft and sends nothing", () => {
    const { onSend } = renderView({ loadingTranscript: true });
    const composer = typeDraft("Tentang niat dalam beramal");
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(composer.value).toBe("Tentang niat dalam beramal");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Enter when idle sends the trimmed draft and clears the composer", () => {
    const { onSend } = renderView({});
    const composer = typeDraft("  Apa itu ayat kursi?  ");
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("Apa itu ayat kursi?");
    expect(composer.value).toBe("");
  });
});

const hint = () => screen.getByTestId("composer-limit");

/**
 * The composer's message ceiling (#256). The chat contract refuses a message
 * over `CHAT_MESSAGE_MAX_LENGTH` with 400, so the composer must never build
 * one: the native `maxLength` bounds typed/pasted input, and the change
 * handler clamps the value itself (the attribute does not constrain a
 * programmatically set value — which is also how this test drives it). Hitting
 * the ceiling says so, in the reader's language.
 */
describe("ChatView message ceiling (#256)", () => {
  it("carries the native maxLength attribute from the contract's ceiling", () => {
    renderView({});
    const field = screen.getByTestId("composer");
    expect(field.getAttribute("maxlength")).toBe(String(CHAT_MESSAGE_MAX_LENGTH));
  });

  it("clamps an over-length draft to the ceiling instead of accepting it", () => {
    renderView({});
    const composer = typeDraft("a".repeat(CHAT_MESSAGE_MAX_LENGTH + 250));
    expect(composer.value).toHaveLength(CHAT_MESSAGE_MAX_LENGTH);
  });

  it("sends at most the ceiling — a message the API will not reject", () => {
    const sent: string[] = [];
    renderView({ onSend: (text) => sent.push(text) });
    const composer = typeDraft("a".repeat(CHAT_MESSAGE_MAX_LENGTH + 250));
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(CHAT_MESSAGE_MAX_LENGTH);
    expect(sent[0]!.length).toBeLessThanOrEqual(CHAT_MESSAGE_MAX_LENGTH);
  });

  it("announces the localized limit hint only once the draft reaches the ceiling", () => {
    renderView({});
    const composer = typeDraft("a".repeat(CHAT_MESSAGE_MAX_LENGTH - 1));
    // One character short is still an ordinary question: no hint, no described-by.
    expect(hint().textContent).toBe("");
    expect(composer.getAttribute("aria-describedby")).toBeNull();

    fireEvent.change(composer, { target: { value: "a".repeat(CHAT_MESSAGE_MAX_LENGTH) } });
    expect(composer.getAttribute("aria-describedby")).toBe("composer-limit");
    // The view renders in `id`, so Intl formats the ceiling as "2.000".
    expect(hint().textContent).toContain("2.000");
    expect(hint().textContent).toContain("karakter");

    // Back under the ceiling the hint clears with the draft.
    fireEvent.change(composer, { target: { value: "a".repeat(CHAT_MESSAGE_MAX_LENGTH - 1) } });
    expect(hint().textContent).toBe("");
  });
});
