// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
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
 * The postprocess appends warning → MT label → disclaimer (chat-postprocess.ts),
 * so the tail can carry the warning repeated or interleaved with the MT label.
 * A rule paragraph that has already been classified must not terminate the
 * walk.
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
    // The model can repeat the canonical line inside ONE trailing paragraph, so
    // the collapse must match every copy in it, not one copy per line.
    {
      name: "[D][W ×2 in one paragraph]",
      tail: [DISCLAIMER, `${WARNING_ID}\n${WARNING_ID}`],
      warning: WARNING_ID,
      footer: true,
    },
    {
      name: "[W ×2 in one paragraph]",
      tail: [`${WARNING_ID}\n${WARNING_ID}`],
      warning: WARNING_ID,
      footer: false,
    },
    // The copy can also repeat SPACE-SEPARATED on ONE line, over
    // `RULE_LINE_MAX`: the line-based collapse misses it, so the paragraph's
    // copy remainder is what collapses.
    {
      name: "[D][W ×3 space-separated in one paragraph]",
      tail: [DISCLAIMER, [WARNING_ID, WARNING_ID, WARNING_ID].join(" ")],
      warning: WARNING_ID,
      footer: true,
    },
    {
      name: "[W ×3 space-separated in one paragraph]",
      tail: [[WARNING_ID, WARNING_ID, WARNING_ID].join(" ")],
      warning: WARNING_ID,
      footer: false,
    },
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
   * A model paragraph that merely OPENS with a marker is prose, not a grade
   * claim. The card's copy authority is the product's canonical line
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

/**
 * The canonical line can sit mid-answer. `applyProductRules` suppresses its own
 * append when the draft already carries the copy, so the delivered text is
 * `[prose][canonical warning][prose][MT label][disclaimer]` and the trailing run
 * holds only the label and the disclaimer — while the frame still reports
 * `dhaifWarning: true`. Both surfaces must still draw the sentence once: the
 * peel owns the copy wherever it sits, so the card draws it and `body` keeps
 * none of it.
 *
 * The first row names the mutation it pins: a peel that walks only the trailing
 * run leaves the copy in `body` while the flag-driven card draws it again.
 */
describe("AnswerCard dhaif warning renders exactly once when the canonical line sits mid-answer (#303)", () => {
  const delivered = ["Jawaban awal.", WARNING_ID, "Jawaban lanjutan.", MT, DISCLAIMER].join("\n\n");

  it("renders the canonical line once — mutation: the peel walks only the trailing run", () => {
    const card = renderCard(delivered, true);
    const text = card.textContent ?? "";
    expect(occurrences(text, WARNING_ID)).toBe(1);
    expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
    // The disclaimer above the trailing run still reaches its footer once, the
    // label stays provenance in the body, and the prose around the copy keeps
    // rendering.
    expect(screen.getAllByTestId("ulama-disclaimer")).toHaveLength(1);
    expect(occurrences(text, DISCLAIMER)).toBe(1);
    expect(occurrences(text, MT)).toBe(1);
    expect(occurrences(text, "Jawaban awal.")).toBe(1);
    expect(occurrences(text, "Jawaban lanjutan.")).toBe(1);
  });

  it("renders the canonical line once when the label shares its paragraph", () => {
    // The ticket's `[copy][MT label]` variant: the peel strips the copy and
    // keeps the label's bytes in place, so the body draws no copy and the card
    // draws exactly one. Mutation: a scan that accepts only sole-copy paragraphs
    // leaves both the copy and the label in `body` — two renders for one wire copy.
    const delivered = [
      "Jawaban awal.",
      `${WARNING_ID}\n${MT}`,
      "Jawaban lanjutan.",
      DISCLAIMER,
    ].join("\n\n");
    const card = renderCard(delivered, true);
    const text = card.textContent ?? "";
    expect(occurrences(text, WARNING_ID)).toBe(1);
    expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
    expect(occurrences(text, MT)).toBe(1);
    expect(screen.getAllByTestId("ulama-disclaimer")).toHaveLength(1);
    expect(occurrences(text, "Jawaban awal.")).toBe(1);
    expect(occurrences(text, "Jawaban lanjutan.")).toBe(1);
  });

  it("pins the residual: a bold-wrapped copy still renders twice", () => {
    // The bold span is the model's markup, not product rule copy, and the
    // no-drop constraint keeps the paragraph whole — so the body draws the copy
    // and the flag-driven card draws it again. Pinned, not endorsed: a widening
    // that eats the model's markup reddens here.
    const card = renderCard(["Jawaban awal.", `**${WARNING_ID}**`, MT].join("\n\n"), true);
    const text = card.textContent ?? "";
    expect(occurrences(text, WARNING_ID)).toBe(2);
    expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
  });

  it("does not card marker-prefixed prose mid-answer (A2)", () => {
    const prose = "[Peringatan] Sebagian ulama menilai riwayat ini lemah.";
    const card = renderCard(["Jawaban awal.", prose, "Jawaban lanjutan.", MT].join("\n\n"), false);
    const text = card.textContent ?? "";
    expect(screen.queryAllByTestId("dhaif-warning")).toHaveLength(0);
    expect(occurrences(text, prose)).toBe(1);
    expect(occurrences(text, WARNING_ID)).toBe(0);
  });

  it("keeps one localized card when a mid-answer copy and the frame flag meet", () => {
    // The copy peels to the card, whose value is the answer's own canonical
    // wording — the localized frame copy is not drawn beside it.
    const card = renderCard(delivered, true, "en");
    const text = card.textContent ?? "";
    expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
    expect(occurrences(text, WARNING_ID)).toBe(1);
    expect(occurrences(text, WARNING_EN)).toBe(0);
  });
});

/**
 * One trailing paragraph interleaves the canonical line with the disclaimer
 * sentence. The copies are the card's line wherever they sit, and the repeated
 * disclaimer sentences are the footer's own line — the standalone disclaimer
 * paragraph below the interleave draws it once — so the interleave is consumed
 * by the two surfaces instead of being drawn in the body as well. A paraphrase
 * that differs from the footer's line is the model's sentence and stays.
 */
describe("AnswerCard renders the interleaved copy + disclaimer paragraph once each (#365)", () => {
  const INTERLEAVE = [WARNING_ID, DISCLAIMER, WARNING_ID, DISCLAIMER, WARNING_ID, DISCLAIMER].join(
    " ",
  );

  it("renders one card and one footer — mutation: peel the copies, keep the interleaved disclaimers", () => {
    const card = renderCard(["Jawaban awal.", INTERLEAVE, DISCLAIMER, MT].join("\n\n"), true);
    const text = card.textContent ?? "";
    expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
    expect(screen.getAllByTestId("ulama-disclaimer")).toHaveLength(1);
    expect(occurrences(text, WARNING_ID)).toBe(1); // the card, never the body too
    expect(occurrences(text, DISCLAIMER)).toBe(1); // the footer, never the body too
    expect(occurrences(text, "Jawaban awal.")).toBe(1);
    expect(occurrences(text, MT)).toBe(1);
  });

  it("splits the boundary interleave: one copy + one disclaimer", () => {
    const card = renderCard(
      ["Jawaban awal.", `${WARNING_ID} ${DISCLAIMER}`, MT, DISCLAIMER].join("\n\n"),
      true,
    );
    const text = card.textContent ?? "";
    expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
    expect(screen.getAllByTestId("ulama-disclaimer")).toHaveLength(1);
    expect(occurrences(text, WARNING_ID)).toBe(1);
    expect(occurrences(text, DISCLAIMER)).toBe(1);
    expect(occurrences(text, "Jawaban awal.")).toBe(1);
  });

  it("keeps a paraphrase that differs from the footer's line (A2)", () => {
    // Not the footer's bytes, so not a repeat the footer draws: the model's
    // sentence stays in the body, beside the footer's own copy.
    const other = "Jawaban ini bukan fatwa; silakan bertanya kepada ulama setempat.";
    const interleave = [WARNING_ID, other, WARNING_ID, other].join(" ");
    const card = renderCard(["Jawaban awal.", interleave, DISCLAIMER, MT].join("\n\n"), true);
    const text = card.textContent ?? "";
    expect(screen.getAllByTestId("dhaif-warning")).toHaveLength(1);
    expect(screen.getAllByTestId("ulama-disclaimer")).toHaveLength(1);
    expect(occurrences(text, WARNING_ID)).toBe(1);
    expect(occurrences(text, other)).toBe(2); // the model's words stay, both copies
    expect(occurrences(text, DISCLAIMER)).toBe(1); // the footer only
  });
});
