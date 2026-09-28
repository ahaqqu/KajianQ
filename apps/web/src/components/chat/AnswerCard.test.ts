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

/** The product's canonical copies, exactly as the card renders them. */
const WARNING_ID = messages.id.dhaifWarningCard;
const WARNING_EN = messages.en.dhaifWarningCard;
const DISCLAIMER = "Jawaban ini bukan fatwa; rujuk ulama untuk keputusan hukum.";
const MT = `[${MACHINE_TRANSLATION_LABEL}]`;

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
 * so the tail is `[warning][MT label]` whenever the draft already carried its
 * disclaimer. The pre-fix peel only looked at the last two paragraphs, left
 * the warning in `split.body` (drawn as prose), and the frame-flag card drew
 * it again.
 *
 * Mutation named: restore the pre-fix two-pop peel and every row below reddens
 * on the count — the ID row reads 2. The `[W][W]` / `[W][MT][W]` /
 * `[D][W][W]` rows are the reviewer's re-seen-marker shapes (A1): a rule
 * paragraph that has already been classified must not terminate the walk.
 */
describe("AnswerCard dhaif warning renders exactly once (#292)", () => {
  const SHAPES: readonly {
    name: string;
    tail: readonly string[];
    warning: string;
    footer: boolean;
  }[] = [
    { name: "[W][MT]", tail: [WARNING_ID, MT], warning: WARNING_ID, footer: false },
    { name: "[W][W]", tail: [WARNING_ID, WARNING_ID], warning: WARNING_ID, footer: false },
    { name: "[W][MT][W]", tail: [WARNING_ID, MT, WARNING_ID], warning: WARNING_ID, footer: false },
    {
      name: "[D][W][W]",
      tail: [DISCLAIMER, WARNING_ID, WARNING_ID],
      warning: WARNING_ID,
      footer: true,
    },
    { name: "[D][MT][W]", tail: [DISCLAIMER, MT, WARNING_ID], warning: WARNING_ID, footer: true },
    { name: "[W][MT][D]", tail: [WARNING_ID, MT, DISCLAIMER], warning: WARNING_ID, footer: true },
  ];

  for (const shape of SHAPES) {
    it(`renders the warning once for ${shape.name}`, () => {
      const card = renderCard(["Jawaban.", ...shape.tail].join("\n\n"), true);
      const text = card.textContent ?? "";
      // Once as the card, never again as body prose.
      expect(occurrences(text, shape.warning)).toBe(1);
      expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
      // The MT label is provenance, not a rule block: when the tail carries
      // it, it still renders once.
      expect(occurrences(text, MT)).toBe(shape.tail.includes(MT) ? 1 : 0);
      // A disclaimer above the warning still reaches the distinct footer.
      expect(screen.queryAllByTestId("ulama-disclaimer")).toHaveLength(shape.footer ? 1 : 0);
    });
  }

  it("renders the EN warning once when the MT label follows it", () => {
    const card = renderCard(["Answer.", WARNING_EN, MT].join("\n\n"), true, "en");
    expect(occurrences(card.textContent ?? "", WARNING_EN)).toBe(1);
    expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
  });

  it("renders the answer's own canonical copy once after a UI language switch", () => {
    // The answer was generated in Indonesian; the UI is now English. Its own
    // warning line is still the product's canonical copy, so it peels once
    // instead of staying in the body beside a second, localized card.
    const card = renderCard(["Jawaban.", WARNING_ID, MT].join("\n\n"), true, "en");
    expect(occurrences(card.textContent ?? "", WARNING_ID)).toBe(1);
    expect(occurrences(card.textContent ?? "", WARNING_EN)).toBe(0);
    expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
  });

  it("renders the answer's own canonical copy once when the UI switches the other way", () => {
    // The symmetric case: an English answer read in the Indonesian UI. Only a
    // copy set covering both locales keeps this at one render.
    const card = renderCard(["Answer.", WARNING_EN, MT].join("\n\n"), true, "id");
    expect(occurrences(card.textContent ?? "", WARNING_EN)).toBe(1);
    expect(occurrences(card.textContent ?? "", WARNING_ID)).toBe(0);
    expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
  });

  /**
   * The trap direction. The peel removes the canonical warning from `body`, so
   * the card must render the peeled value even when the frame flag is false —
   * otherwise the canonical sentence would be displayed zero times. The peel
   * and the render are decided from the same peeled value
   * (`split.warning ?? (flag ? cardCopy : null)`), and this row pins that a
   * peeled warning is displayed once with the flag off.
   */
  it("renders a peeled warning once even when the frame flag is false", () => {
    const card = renderCard(["Jawaban.", WARNING_ID, MT].join("\n\n"), false);
    expect(occurrences(card.textContent ?? "", WARNING_ID)).toBe(1);
    expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
  });

  it("keeps the pre-existing frame-flag path working when the text carries no warning", () => {
    // Rehydrated text without the line: the card still shows the frame's copy.
    const card = renderCard("Jawaban tanpa baris peringatan.", true);
    expect(occurrences(card.textContent ?? "", WARNING_ID)).toBe(1);
    expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
  });

  /**
   * A2 — a model paragraph that merely OPENS with a marker is prose, not a
   * grade claim. The card's copy authority is the product's canonical line
   * (`split.warning`), or the frame flag; never the paragraph's own wording.
   */
  it("does not turn marker-prefixed prose into a trust card when the frame says no dhaif", () => {
    const prose = "[Peringatan] Sebagian ulama menilai riwayat ini lemah.";
    const card = renderCard(["Jawaban.", prose, MT].join("\n\n"), false);
    const text = card.textContent ?? "";
    expect(screen.queryAllByTestId("dhaif-warning")).toHaveLength(0);
    expect(occurrences(text, WARNING_ID)).toBe(0);
    expect(occurrences(text, prose)).toBe(1); // kept as ordinary prose
  });

  it("renders the localized canonical copy once when the frame flags a dhaif and the prose is not the copy", () => {
    const prose = "[Peringatan] Sebagian ulama menilai riwayat ini lemah.";
    const card = renderCard(["Jawaban.", prose, MT].join("\n\n"), true);
    const text = card.textContent ?? "";
    expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
    expect(occurrences(text, WARNING_ID)).toBe(1);
    expect(occurrences(text, prose)).toBe(1);
  });
});
