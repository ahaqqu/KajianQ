import { describe, expect, it } from "vitest";
import {
  type AnswerInline,
  MACHINE_TRANSLATION_LABEL,
  renderBodyBlocks,
  type SplitAnswer,
  splitAnswerBlocks,
} from "./chat-render";
import { messages } from "./i18n-messages";

/**
 * The dhaif warning must render exactly once even when ONE trailing paragraph
 * repeats the canonical line: the paragraph opens with a warning marker and is
 * short enough for `RULE_LINE_MAX`, so `classifyRule` accepts it; the warning
 * branch then rejects it because `CANONICAL_WARNINGS` does not contain a
 * two-copy paragraph, so it stays in `body` and `warning` stays `null` while the
 * frame flag (`dhaifWarning: true` — the text does carry the copy) renders the
 * card on top, drawing the sentence twice over.
 *
 * The collapse must stay narrow: widening it to "any paragraph opening with a
 * warning marker" eats prose that merely opens with one, so a repeated
 * marker-prefixed paragraph stays whole.
 */

/** The product's canonical copies — read from the i18n copy the card renders. */
const WARNING_ID = messages.id.dhaifWarningCard;
const WARNING_EN = messages.en.dhaifWarningCard;
const DISCLAIMER = "Jawaban ini bukan fatwa; rujuk ulama untuk keputusan hukum.";
const MT = `[${MACHINE_TRANSLATION_LABEL}]`;
const PROSE = "Surat Al-Ikhlas menegaskan keesaan Allah.";

/** Occurrences of `needle` in a string, so "exactly once" is measurable. */
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const inlineText = (inlines: readonly AnswerInline[]): string =>
  inlines
    .map((inline) =>
      inline.kind === "citation"
        ? inline.label
        : inline.kind === "text"
          ? inline.text
          : inlineText(inline.children),
    )
    .join("");

/** What `body` actually draws: every block's text, as the card renders it. */
const bodyText = (body: string): string =>
  renderBodyBlocks(body, [])
    .flatMap((block) =>
      block.kind === "para" ? [inlineText(block.inlines)] : block.items.map(inlineText),
    )
    .join("\n\n");

/**
 * The two display surfaces of one answer: `body` as prose, and the peeled
 * values as the card/footer (the frame-flag card is the only third surface,
 * and it renders the canonical copy — never the body's own wording).
 */
const displayed = (split: SplitAnswer): string =>
  [split.body, split.warning ?? "", split.disclaimer ?? ""].join("\n\n");

describe("splitAnswerBlocks — a trailing paragraph that repeats the canonical line (#348)", () => {
  // One paragraph carrying two copies of the canonical line, short enough for
  // `RULE_LINE_MAX`.
  const delivered = (copy: string) => [PROSE, DISCLAIMER, `${copy}\n${copy}`].join("\n\n");

  it.each([
    ["ID", WARNING_ID],
    ["EN", WARNING_EN],
  ])(
    "peels the delivered tail and leaves the %s sentence at exactly one render",
    (_locale, copy) => {
      const split = splitAnswerBlocks(delivered(copy));
      // The card's value is ONE copy — not the paragraph, whose second copy the
      // card would then draw a second time.
      expect(split.warning).toBe(copy);
      expect(split.body).toBe(PROSE);
      expect(split.disclaimer).toBe(DISCLAIMER);
      expect(occurrences(displayed(split), copy)).toBe(1);
    },
  );

  it("leaves no body block carrying the sentence", () => {
    // The render seam, not just the string: `renderBodyBlocks` must produce no
    // paragraph that draws the canonical sentence, whichever surface wins.
    const split = splitAnswerBlocks(delivered(WARNING_ID));
    expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
    expect(bodyText(split.body)).toBe(PROSE);
  });

  it("collapses a three-copy paragraph to one render — exactly once, never zero", () => {
    const split = splitAnswerBlocks(
      [PROSE, [WARNING_ID, WARNING_ID, WARNING_ID].join("\n")].join("\n\n"),
    );
    expect(split.warning).toBe(WARNING_ID);
    expect(occurrences(displayed(split), WARNING_ID)).toBe(1);
  });

  it("drops the repeat when a single canonical line follows it", () => {
    // The walk reads right-to-left, so the later single line sets the card; the
    // earlier repeat paragraph must not survive in `body` beside it.
    const split = splitAnswerBlocks(
      [PROSE, `${WARNING_ID}\n${WARNING_ID}`, WARNING_ID].join("\n\n"),
    );
    expect(split.warning).toBe(WARNING_ID);
    expect(split.body).toBe(PROSE);
    expect(occurrences(displayed(split), WARNING_ID)).toBe(1);
  });

  it("peels the repeat paragraph with the MT label after it (#292's shape, new form)", () => {
    const split = splitAnswerBlocks([PROSE, `${WARNING_ID}\n${WARNING_ID}`, MT].join("\n\n"));
    expect(split.warning).toBe(WARNING_ID);
    expect(split.body).toBe([PROSE, MT].join("\n\n"));
    expect(occurrences(displayed(split), WARNING_ID)).toBe(1);
  });

  it("keeps the disclaimer above the repeat in every position", () => {
    // The disclaimer must still reach its footer, whichever side of the repeat
    // paragraph it sits on; a peel that stops the walk loses it.
    for (const text of [
      [PROSE, DISCLAIMER, `${WARNING_ID}\n${WARNING_ID}`].join("\n\n"),
      [PROSE, `${WARNING_ID}\n${WARNING_ID}`, DISCLAIMER].join("\n\n"),
    ]) {
      const split = splitAnswerBlocks(text);
      expect(split.disclaimer).toBe(DISCLAIMER);
      expect(split.warning).toBe(WARNING_ID);
      expect(split.body).toBe(PROSE);
    }
  });
});

describe("splitAnswerBlocks — the A2 guard on a repeated paragraph (#348)", () => {
  it("keeps a repeated marker-prefixed prose paragraph as prose, whole", () => {
    // The paragraph opens with `[Peringatan]` twice and is short enough to
    // classify, but no line of it is the product's copy — so it is prose, and it
    // must stay byte-for-byte.
    const prose = "[Peringatan] Sebagian ulama menilai riwayat ini lemah.";
    const paragraph = `${prose}\n${prose}`;
    const split = splitAnswerBlocks([PROSE, paragraph, MT].join("\n\n"));
    expect(split.warning).toBeNull();
    expect(split.body).toBe([PROSE, paragraph, MT].join("\n\n"));
    expect(occurrences(displayed(split), WARNING_ID)).toBe(0);
  });

  it("keeps a paragraph that mixes the copy with prose whole — no content is dropped", () => {
    // Not a repeat of the canonical line, so it is not the card's copy: the
    // peel may not eat the prose line to reach the copy (constraint: no body
    // paragraph is dropped unless the card renders that copy).
    const paragraph = `${WARNING_ID}\n[Peringatan] Sebagian ulama menilai riwayat ini lemah.`;
    const split = splitAnswerBlocks([PROSE, paragraph, MT].join("\n\n"));
    expect(split.warning).toBeNull();
    expect(split.body).toBe([PROSE, paragraph, MT].join("\n\n"));
    expect(occurrences(displayed(split), WARNING_ID)).toBe(1); // the prose copy only
  });

  it("does not treat a reworded repeat as the copy", () => {
    const reworded = "[Peringatan] Hadits ini lemah, jangan dijadikan dalil.";
    const paragraph = `${reworded}\n${reworded}`;
    const split = splitAnswerBlocks([PROSE, paragraph].join("\n\n"));
    expect(split.warning).toBeNull();
    expect(split.body).toBe([PROSE, paragraph].join("\n\n"));
  });
});
