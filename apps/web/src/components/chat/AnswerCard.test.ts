// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSessionMessage } from "@app/contracts";
import { LocaleCtx, messages, type Locale } from "../../lib/i18n";
import { MACHINE_TRANSLATION_LABEL } from "../../lib/chat-render";
import { AnswerCard } from "./AnswerCard";

// React 19 + vitest: mark the environment for act() (testing-library's flushes).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const WARNING_ID =
  "[Peringatan] Hadits yang dikutip berderajat lemah (dhaif); tidak dapat dijadikan dalil utama.";
const WARNING_EN =
  "[Warning] The cited hadith is graded weak (dhaif); it may not be used as a primary proof.";

function renderCard(content: string, dhaifWarning: boolean, locale: Locale = "id") {
  const message: ChatSessionMessage = {
    id: "m-1",
    role: "assistant",
    content,
    citations: { messageId: "m-1", citations: [], refusal: false, dhaifWarning },
    createdAt: 0,
  };
  render(
    createElement(
      LocaleCtx.Provider,
      { value: locale },
      createElement(AnswerCard, { message, onOpenCitation: () => {} }),
    ),
  );
  return screen.getByTestId("message-assistant");
}

/** Occurrences of `needle` in a rendered card, so "twice" is measurable. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * #292 — the dhaif warning renders twice when the MT label follows it. The
 * postprocess appends warning → MT label → disclaimer (chat-postprocess.ts),
 * so on the common Indonesian path the tail is `[warning][MT label]`. The
 * pre-fix peel only looked at the last two paragraphs, left the warning in
 * `split.body` (drawn as prose), and the frame-flag card drew it again.
 *
 * Mutation named: restore the pre-fix two-pop peel and the first two rows
 * below redden on `occurrences(..., WARNING_ID)).toBe(1)` — it reads 2. The
 * `chat-render.test.ts` row `peels the warning when the MT label follows it`
 * is the cheaper falsification of the same mutation.
 */
describe("AnswerCard dhaif warning renders exactly once (#292)", () => {
  it("renders the ID warning once when the MT label follows it", () => {
    const card = renderCard(
      ["Jawaban.", WARNING_ID, `[${MACHINE_TRANSLATION_LABEL}]`].join("\n\n"),
      true,
    );
    expect(card.textContent ?? "").toContain(WARNING_ID);
    expect(occurrences(card.textContent ?? "", WARNING_ID)).toBe(1);
    expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
    // The MT label is provenance, not a rule block: it still renders, once.
    expect(occurrences(card.textContent ?? "", `[${MACHINE_TRANSLATION_LABEL}]`)).toBe(1);
  });

  it("renders the EN warning once when the MT label follows it", () => {
    const card = renderCard(
      ["Answer.", WARNING_EN, `[${MACHINE_TRANSLATION_LABEL}]`].join("\n\n"),
      true,
      "en",
    );
    expect(occurrences(card.textContent ?? "", WARNING_EN)).toBe(1);
    expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
  });

  /**
   * The trap direction. The peel always removes the warning from `body`, so
   * the card must render the peeled value even when the frame flag is false —
   * otherwise the canonical sentence would be displayed zero times. The peel
   * and the render are therefore decided from the same peeled value
   * (`split.warning ?? (flag ? cardCopy : null)`), and this row pins that a
   * peeled warning is displayed once with the flag off.
   */
  it("renders a peeled warning once even when the frame flag is false", () => {
    const card = renderCard(
      ["Jawaban.", WARNING_ID, `[${MACHINE_TRANSLATION_LABEL}]`].join("\n\n"),
      false,
    );
    expect(occurrences(card.textContent ?? "", WARNING_ID)).toBe(1);
    expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
  });

  it("keeps the pre-existing frame-flag path working when the text carries no warning", () => {
    // Rehydrated text without the line: the card still shows the frame's copy.
    const card = renderCard("Jawaban tanpa baris peringatan.", true);
    expect(occurrences(card.textContent ?? "", messages.id.dhaifWarningCard)).toBe(1);
    expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
  });
});
