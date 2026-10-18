import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import {
  type AnswerInline,
  MACHINE_TRANSLATION_LABEL,
  renderBodyBlocks,
  type SplitAnswer,
  splitAnswerBlocks,
} from "./chat-render";
import { messages } from "./i18n-messages";

/**
 * The canonical dhaif line can sit wherever the model placed it, not only in the
 * trailing rule run. `applyProductRules` suppresses its own append when the draft
 * already carries the copy (`hasWeakWarning` in `chat-postprocess.ts`), so the
 * delivered text is `[prose][canonical warning][prose][MT label][disclaimer]`:
 * the trailing run the peel walks holds only the label and the disclaimer, while
 * the frame flag (`dhaifWarning: true`, derived from the same delivered string)
 * still draws the card. The peel must own that paragraph wherever it sits, or the
 * sentence renders twice — once as prose, once as the card.
 *
 * The card's copy authority is unchanged: a paragraph made solely of the
 * product's canonical copy moves to the card (`CANONICAL_WARNINGS` is the one
 * set, both directions), so marker-prefixed prose that is not that copy stays in
 * the body whole (A2), and a paragraph interleaving copies with the disclaimer
 * stays prose because it is not made solely of copies.
 */

/** The product's canonical copies — read from the i18n copy the card renders. */
const WARNING_ID = messages.id.dhaifWarningCard;
const WARNING_EN = messages.en.dhaifWarningCard;
const DISCLAIMER = "Jawaban ini bukan fatwa; rujuk ulama untuk keputusan hukum.";
const MT = `[${MACHINE_TRANSLATION_LABEL}]`;
const PROSE = ["Paragraf pertama.", "Paragraf kedua.", "Paragraf ketiga."] as const;

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
 * The three display surfaces of one answer, as `AnswerCard.tsx` draws them:
 * `body` as prose, the card's warning value (`split.warning`, or the canonical
 * copy when the frame flag is set and the peel found nothing), and the footer's
 * disclaimer. `cardFlag` models the frame's `dhaifWarning: true`.
 */
const displayed = (split: SplitAnswer, cardFlag: boolean): string =>
  [
    bodyText(split.body),
    split.warning ?? (cardFlag ? WARNING_ID : ""),
    split.disclaimer ?? "",
  ].join("\n\n");

/** The delivered shape `[prose][copy…][prose][MT label][disclaimer]`, varied. */
function deliveredShape(input: {
  /** Where among the prose paragraphs the copy paragraph sits (0..PROSE.length). */
  warningAt: number;
  /** How many copies the one paragraph carries, newline-separated. */
  copies: number;
  /** Where the disclaimer sits: the footer after the label, the body, or absent. */
  disclaimer: "footer" | "body" | "none";
}): string {
  const warning = Array.from({ length: input.copies }, () => WARNING_ID).join("\n");
  const paragraphs: string[] = [...PROSE];
  paragraphs.splice(input.warningAt, 0, warning);
  if (input.disclaimer === "body") {
    // Above the prose, so a prose paragraph stops the trailing walk before it:
    // a disclaimer in the trailing run is the footer's (the walk keeps going
    // through rule paragraphs).
    paragraphs.unshift(DISCLAIMER);
  }
  paragraphs.push(MT);
  if (input.disclaimer === "footer") paragraphs.push(DISCLAIMER);
  return paragraphs.join("\n\n");
}

describe("splitAnswerBlocks — the canonical line mid-answer (#303)", () => {
  // The reachable shape's own row, with the mutation named: a trailing-only
  // peel leaves this copy in `body` and the flag card draws it again.
  it("peels the delivered `[prose][copy][prose][MT][disclaimer]` shape — mutation: the peel stops at the trailing run", () => {
    const split = splitAnswerBlocks([PROSE[0], WARNING_ID, PROSE[1], MT, DISCLAIMER].join("\n\n"));
    expect(split.warning).toBe(WARNING_ID);
    expect(split.disclaimer).toBe(DISCLAIMER);
    expect(split.body).toBe([PROSE[0], PROSE[1], MT].join("\n\n"));
    expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
    expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
  });

  it.each([
    ["ID", WARNING_ID],
    ["EN", WARNING_EN],
  ])(
    "peels the %s copy at the first, middle and last body position, at one render",
    (_locale, copy) => {
      for (const paragraphs of [
        [copy, PROSE[0], PROSE[1], MT],
        [PROSE[0], copy, PROSE[1], MT],
        [PROSE[0], PROSE[1], copy, MT],
        [PROSE[0], PROSE[1], MT, copy],
      ]) {
        const split = splitAnswerBlocks(paragraphs.join("\n\n"));
        expect(split.warning).toBe(copy);
        expect(occurrences(bodyText(split.body), copy)).toBe(0);
        expect(occurrences(displayed(split, true), copy)).toBe(1);
      }
    },
  );

  it("drops every canonical-copy paragraph, not only the first found", () => {
    // Two separate paragraphs carrying the product's copy: the card draws one,
    // so the body may keep none of them.
    const split = splitAnswerBlocks([PROSE[0], WARNING_ID, PROSE[1], WARNING_ID, MT].join("\n\n"));
    expect(split.warning).toBe(WARNING_ID);
    expect(split.body).toBe([PROSE[0], PROSE[1], MT].join("\n\n"));
    expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
  });

  it("keeps one render when a mid-answer copy and a trailing copy meet", () => {
    const split = splitAnswerBlocks(
      [PROSE[0], WARNING_ID, PROSE[1], WARNING_ID, MT, DISCLAIMER].join("\n\n"),
    );
    expect(split.warning).toBe(WARNING_ID);
    expect(split.disclaimer).toBe(DISCLAIMER);
    expect(split.body).toBe([PROSE[0], PROSE[1], MT].join("\n\n"));
    expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
  });

  /**
   * The enumeration over the reachable shape: copy position × copies per
   * paragraph × disclaimer position. Every row asserts the canonical line renders
   * exactly once, the body keeps every prose paragraph in order, and the label
   * and the disclaimer are each rendered once on the surface that owns them.
   */
  describe("enumeration: body position × copies × disclaimer position", () => {
    const rows = [0, 1, 2, 3].flatMap((warningAt) =>
      [1, 2, 3].flatMap((copies) =>
        (["footer", "body", "none"] as const).map((disclaimer) => ({
          warningAt,
          copies,
          disclaimer,
        })),
      ),
    );

    it.each(rows)(
      "exactly one render for copy at $warningAt × $copies copies × disclaimer in $disclaimer",
      (row) => {
        const split = splitAnswerBlocks(deliveredShape(row));
        // The canonical line: once, as the card's value, never in the body.
        expect(split.warning).toBe(WARNING_ID);
        expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
        expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);

        // No prose paragraph is dropped, and order is kept.
        const drawn = bodyText(split.body).split("\n\n");
        expect(drawn).toEqual([...(row.disclaimer === "body" ? [DISCLAIMER] : []), ...PROSE, MT]);

        // The label is provenance and stays in the body, once.
        expect(occurrences(bodyText(split.body), MT)).toBe(1);

        // The disclaimer reaches the footer when it is trailing; in the body it
        // renders there once and is not also a footer; absent renders nowhere.
        if (row.disclaimer === "footer") {
          expect(split.disclaimer).toBe(DISCLAIMER);
          expect(occurrences(displayed(split, true), DISCLAIMER)).toBe(1);
        } else if (row.disclaimer === "body") {
          expect(split.disclaimer).toBeNull();
          expect(occurrences(bodyText(split.body), DISCLAIMER)).toBe(1);
          expect(occurrences(displayed(split, true), DISCLAIMER)).toBe(1);
        } else {
          expect(split.disclaimer).toBeNull();
          expect(occurrences(displayed(split, true), DISCLAIMER)).toBe(0);
        }
      },
    );
  });

  it("holds for any positions and copy counts (property)", () => {
    // The same invariant the enumeration states, over shapes the matrix does
    // not enumerate: the copy paragraph's index anywhere in the paragraph list,
    // the number of copies, and whether the copy is space- or newline-separated.
    const segment = fc.constantFrom<string>(...PROSE, MT, "Kalimat model lain.");
    fc.assert(
      fc.property(
        fc.array(segment, { maxLength: 6 }),
        fc.nat({ max: 7 }),
        fc.integer({ min: 1, max: 4 }),
        fc.boolean(),
        (others, rawAt, copies, spaceSeparated) => {
          const at = Math.min(rawAt, others.length);
          const copy = Array.from({ length: copies }, () => WARNING_ID).join(
            spaceSeparated ? " " : "\n",
          );
          const paragraphs = [...others];
          paragraphs.splice(at, 0, copy);
          const split = splitAnswerBlocks(paragraphs.join("\n\n"));
          // Exactly once, never zero: the card owns the copy and `body` has none.
          expect(split.warning).toBe(WARNING_ID);
          expect(occurrences(bodyText(split.body), WARNING_ID)).toBe(0);
          expect(occurrences(displayed(split, true), WARNING_ID)).toBe(1);
          // Every other paragraph survives in order, none dropped.
          expect(bodyText(split.body)).toBe(others.join("\n\n"));
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("splitAnswerBlocks — the A2 guard for a mid-answer copy (#303)", () => {
  it("leaves marker-prefixed prose that is not the copy whole in the body", () => {
    const prose = "[Peringatan] Sebagian ulama menilai riwayat ini lemah.";
    const split = splitAnswerBlocks([PROSE[0], prose, PROSE[1], MT].join("\n\n"));
    expect(split.warning).toBeNull();
    expect(split.body).toBe([PROSE[0], prose, PROSE[1], MT].join("\n\n"));
    expect(occurrences(bodyText(split.body), prose)).toBe(1);
  });

  it("leaves a paragraph mixing the copy with the model's words whole", () => {
    // Not made solely of copies, so it is not the card's copy: no paragraph is
    // dropped unless the card renders exactly that copy.
    const mixed = `${WARNING_ID}\n[Peringatan] Sebagian ulama menilai riwayat ini lemah.`;
    const split = splitAnswerBlocks([PROSE[0], mixed, PROSE[1], MT].join("\n\n"));
    expect(split.warning).toBeNull();
    expect(split.body).toBe([PROSE[0], mixed, PROSE[1], MT].join("\n\n"));
  });

  it("does not card a reworded near-copy mid-answer", () => {
    const reworded = "[Peringatan] Hadits ini lemah, jangan dijadikan dalil.";
    const split = splitAnswerBlocks([PROSE[0], reworded, PROSE[1], MT].join("\n\n"));
    expect(split.warning).toBeNull();
    expect(split.body).toBe([PROSE[0], reworded, PROSE[1], MT].join("\n\n"));
  });
});
