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
 * The peel must collapse a trailing paragraph that repeats a canonical line
 * SPACE-SEPARATED, not only newline-separated: `classifyRule` splits a
 * paragraph on "\n", so a one-line paragraph is a single over-cap line that
 * never byte-equals the copy and would classify as `null`, stopping the walk
 * and leaving the prose copy for the card to draw over.
 *
 * Widening the collapse to any paragraph that merely CONTAINS the copy would
 * eat the model's own words, so a copy mixed with prose stays whole.
 */

/** The product's canonical copies — read from the i18n copy the card renders. */
const WARNING_ID = messages.id.dhaifWarningCard;
const WARNING_EN = messages.en.dhaifWarningCard;
const DISCLAIMER = "Jawaban ini bukan fatwa; rujuk ulama untuk keputusan hukum.";
const MT = `[${MACHINE_TRANSLATION_LABEL}]`;
const PROSE = "Surat Al-Ikhlas menegaskan keesaan Allah.";

/** Three copies of one canonical line, space-separated on a single line. */
const delivered = (copy: string): string => [copy, copy, copy].join(" ");

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
 * The three display surfaces of one answer: `body` as prose, the card's
 * warning line, and the footer's disclaimer. The card draws `split.warning`
 * when the peel found the product's copy, and otherwise — only while the
 * frame's `dhaifWarning` flag is set — the canonical copy itself
 * (`AnswerCard.tsx`: `split.warning ?? (citations.dhaifWarning ?
 * t(locale, "dhaifWarningCard") : null)`). `cardFlag` models that second case,
 * so a row that says "4 displayed" can assert the 4 instead of the 3 the peel
 * fields alone carry.
 */
const displayed = (split: SplitAnswer, cardFlag = false): string =>
  [split.body, split.warning ?? (cardFlag ? WARNING_ID : ""), split.disclaimer ?? ""].join("\n\n");

describe("splitAnswerBlocks — a space-separated one-line repeat (#361)", () => {
  it("pins the delivered geometry: three ID copies on one line, 281 chars", () => {
    // The whole paragraph is one over-cap line, so no line of it ever equals
    // the copy.
    expect(delivered(WARNING_ID)).toHaveLength(281);
    expect(delivered(WARNING_ID)).not.toContain("\n");
  });

  it.each([
    ["ID", WARNING_ID],
    ["EN", WARNING_EN],
  ])(
    "peels the space-separated repeat and leaves the %s sentence at exactly one render",
    (_locale, copy) => {
      const split = splitAnswerBlocks([PROSE, delivered(copy)].join("\n\n"));
      expect(split.warning).toBe(copy);
      expect(split.body).toBe(PROSE);
      expect(occurrences(displayed(split), copy)).toBe(1);
    },
  );

  it("leaves no body block carrying the sentence", () => {
    // The render seam, not just the string: `renderBodyBlocks` must produce no
    // paragraph that draws the canonical sentence, whichever surface wins.
    const split = splitAnswerBlocks([PROSE, delivered(WARNING_ID)].join("\n\n"));
    expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
    expect(bodyText(split.body)).toBe(PROSE);
  });

  it("peels the space-separated repeat with the MT label after it (#292's shape, new form)", () => {
    const split = splitAnswerBlocks([PROSE, delivered(WARNING_ID), MT].join("\n\n"));
    expect(split.warning).toBe(WARNING_ID);
    expect(split.body).toBe([PROSE, MT].join("\n\n"));
    expect(occurrences(displayed(split), WARNING_ID)).toBe(1);
  });

  it("keeps the disclaimer above the space-separated repeat in every position", () => {
    // The disclaimer must still reach its footer, whichever side of the repeat
    // paragraph it sits on; a peel that stops the walk loses it.
    for (const text of [
      [PROSE, DISCLAIMER, delivered(WARNING_ID)].join("\n\n"),
      [PROSE, delivered(WARNING_ID), DISCLAIMER].join("\n\n"),
    ]) {
      const split = splitAnswerBlocks(text);
      expect(split.disclaimer).toBe(DISCLAIMER);
      expect(split.warning).toBe(WARNING_ID);
      expect(split.body).toBe(PROSE);
    }
  });

  it("drops a two-copy space-separated paragraph sitting left of a single copy", () => {
    // Two copies, under the cap and marker-opening: the peel must recognise the
    // paragraph as copies, not as a rule whose text is not the canonical line
    // (which would leave both prose copies beside the card's one).
    const two = [WARNING_ID, WARNING_ID].join(" ");
    const split = splitAnswerBlocks([PROSE, two, WARNING_ID].join("\n\n"));
    expect(split.warning).toBe(WARNING_ID);
    expect(split.body).toBe(PROSE);
    expect(occurrences(displayed(split), WARNING_ID)).toBe(1);
  });
});

describe("splitAnswerBlocks — the A2 guard on a space-separated line (#361)", () => {
  it("keeps a copy mixed with the model's own words whole — no content is dropped", () => {
    // One line, the copy first: the remainder is the model's sentence, so the
    // paragraph is prose and must stay byte-for-byte (no paragraph is dropped
    // unless it is a copy the card renders).
    const paragraph = `${WARNING_ID} [Peringatan] Sebagian ulama menilai riwayat ini lemah.`;
    const split = splitAnswerBlocks([PROSE, paragraph, MT].join("\n\n"));
    expect(split.warning).toBeNull();
    expect(split.body).toBe([PROSE, paragraph, MT].join("\n\n"));
    expect(occurrences(displayed(split), WARNING_ID)).toBe(1); // the prose copy only
  });

  it("keeps a long marker-prefixed paragraph whole (probe p3)", () => {
    // A paragraph over `RULE_LINE_MAX` classifies as prose, and for a shorter
    // one the copy remainder is what keeps it prose when it carries the model's
    // own words — a paragraph that merely OPENS with the marker stays whole.
    const paragraph =
      "[Peringatan] Sebagian ulama menilai riwayat ini lemah karena sanadnya terputus, sehingga hadits ini tidak dapat dijadikan dalil utama dalam masalah akidah. [Warning] Para ulama lain menguatkan riwayat ini melalui jalur yang berbeda, dan mereka berbeda pendapat tentang kehujjahannya.";
    const split = splitAnswerBlocks([PROSE, paragraph].join("\n\n"));
    expect(split.warning).toBeNull();
    expect(split.body).toBe([PROSE, paragraph].join("\n\n"));
    expect(occurrences(bodyText(split.body), paragraph)).toBe(1);
  });

  it("does not treat a reworded space-separated near-copy as the copy (probe p10)", () => {
    const reworded = "[Peringatan] Hadits ini lemah, jangan dijadikan dalil.";
    const paragraph = [reworded, reworded].join(" ");
    const split = splitAnswerBlocks([PROSE, paragraph].join("\n\n"));
    expect(split.warning).toBeNull();
    expect(split.body).toBe([PROSE, paragraph].join("\n\n"));
  });

  it("leaves the p9d interleave as prose — the residual #361 does not claim", () => {
    // A paragraph that interleaves copies with the disclaimer sentence is not
    // made solely of copies, and the web peel holds no canonical disclaimer
    // literal — only its opening marker, by design — so it stays prose: the
    // warning still renders in `body`, the flag-driven card draws the canonical
    // copy on top of it, and the disclaimer sentence renders both in `body` and
    // in the footer. Collapsing it would need a hand-copied disclaimer string
    // or a marker-based match that eats the model's own words; this row pins
    // that residual.
    for (const paraphrase of [
      DISCLAIMER, // the canonical ID phrasing
      "Jawaban ini bukan fatwa; untuk keputusan hukum, rujuklah ulama yang terpercaya.",
    ]) {
      const interleave = [
        WARNING_ID,
        paraphrase,
        WARNING_ID,
        paraphrase,
        WARNING_ID,
        paraphrase,
      ].join(" ");
      const split = splitAnswerBlocks([PROSE, interleave, paraphrase, MT].join("\n\n"));
      expect(split.warning).toBeNull();
      expect(split.body).toBe([PROSE, interleave, MT].join("\n\n"));
      expect(split.disclaimer).toBe(paraphrase); // the footer still gets its copy
      expect(occurrences(displayed(split), WARNING_ID)).toBe(3); // the peel fields: `body` only
      expect(occurrences(displayed(split, true), WARNING_ID)).toBe(4); // + the frame-flag card
      expect(occurrences(displayed(split), paraphrase)).toBe(4); // 3 in prose, 1 in the footer
    }
  });
});
