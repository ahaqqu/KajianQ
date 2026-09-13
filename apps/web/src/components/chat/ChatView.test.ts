// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
