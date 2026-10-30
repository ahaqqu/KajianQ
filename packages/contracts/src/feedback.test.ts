import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";
import {
  FeedbackAnchorSchema,
  FeedbackFlagShape,
  FeedbackRequestSchema,
  FeedbackThumbShape,
  type FeedbackRequest,
} from "./feedback";
import { isStorableText } from "./chat";

/**
 * Feedback contracts. These are trap tests: the anchor taxonomy only
 * protects trust if malformed shapes fail LOUDLY here — a category anchored
 * to the wrong element class, a payload that is neither thumb nor flag (or
 * both), an oversized free-text — every one must be a parse failure, never a
 * stored row.
 */

function base(overrides: Partial<FeedbackRequest> = {}): FeedbackRequest {
  return {
    messageId: "0b8fe2a5-6b1a-4d0e-9a7c-1f2e3d4c5b6a",
    rating: "up",
    ...overrides,
  } as FeedbackRequest;
}

describe("FeedbackRequestSchema", () => {
  it("accepts an anonymous thumb with no anchor", () => {
    const parsed = v.parse(FeedbackRequestSchema, base());
    expect(parsed.rating).toBe("up");
    expect(parsed.anchor).toBeUndefined();
  });

  it("accepts each anchored flag shape with its paired category", () => {
    const pairs = [
      { type: "chunk", category: "irrelevant_chunk", id: "chunk-1" },
      { type: "citation", category: "wrong_citation", id: "QS. 2:255" },
      { type: "translation", category: "bad_machine_translation", id: "QS. 2:255" },
      { type: "grade", category: "questionable_grade", id: "HR. Malik no. 18" },
      {
        type: "chain",
        category: "questionable_grade",
        id: "HR. Malik no. 18",
        chainIndex: 1,
        grade: "grade-a",
        grader: "grader-a",
      },
    ] as const;
    for (const anchor of pairs) {
      const parsed = v.parse(FeedbackRequestSchema, base({ rating: undefined, anchor }));
      expect(parsed.anchor).toEqual(anchor);
    }
    expect(v.is(FeedbackAnchorSchema, { ...pairs[0] })).toBe(true);
  });

  it("accepts optional free text on both shapes", () => {
    expect(() => v.parse(FeedbackRequestSchema, base({ freeText: "salah kutip" }))).not.toThrow();
    expect(() =>
      v.parse(
        FeedbackRequestSchema,
        base({
          rating: undefined,
          anchor: { type: "chunk", category: "irrelevant_chunk", id: "chunk-1" },
          freeText: "panel kedua salah",
        }),
      ),
    ).not.toThrow();
    // Free text alone is neither a thumb nor a flag — still rejected.
    expect(v.is(FeedbackRequestSchema, base({ rating: undefined, freeText: "x" }))).toBe(false);
  });

  // -- Traps -------------------------------------------------------------

  it("rejects a payload that is neither a thumb nor a flag", () => {
    const empty = base({ rating: undefined });
    expect(v.is(FeedbackRequestSchema, empty)).toBe(false);
  });

  it("rejects a payload that carries both a thumb and an anchor", () => {
    const both = base({
      anchor: { type: "chunk", category: "irrelevant_chunk", id: "chunk-1" },
    });
    expect(v.is(FeedbackRequestSchema, both)).toBe(false);
  });

  it("structurally forbids the sibling key in each shape", () => {
    // The one-shape invariant is carried by the union's shapes, not a
    // cross-field check, so each shape's own members prove the rule: the
    // thumb shape's anchor slot and the flag shape's rating slot are
    // optional-never — present keys fail, absent keys pass.
    expect(
      v.is(FeedbackThumbShape, {
        messageId: "0b8fe2a5-6b1a-4d0e-9a7c-1f2e3d4c5b6a",
        rating: "up",
        anchor: { type: "chunk", category: "irrelevant_chunk", id: "chunk-1" },
      }),
    ).toBe(false);
    expect(
      v.is(FeedbackFlagShape, {
        messageId: "0b8fe2a5-6b1a-4d0e-9a7c-1f2e3d4c5b6a",
        rating: "up",
        anchor: { type: "chunk", category: "irrelevant_chunk", id: "chunk-1" },
      }),
    ).toBe(false);
  });

  it("rejects a category anchored to the wrong element class", () => {
    // "irrelevant_chunk" belongs to chunk anchors only; a grade badge cannot
    // carry it.
    expect(
      v.is(FeedbackAnchorSchema, { type: "grade", category: "irrelevant_chunk", id: "x" }),
    ).toBe(false);
    // A chunk anchor cannot claim a citation complaint either.
    expect(
      v.is(FeedbackAnchorSchema, { type: "chunk", category: "wrong_citation", id: "chunk-1" }),
    ).toBe(false);
    // A chain row's flag is a grade complaint, never a citation one.
    expect(
      v.is(FeedbackAnchorSchema, {
        type: "chain",
        category: "wrong_citation",
        id: "QS. 2:255",
        chainIndex: 0,
      }),
    ).toBe(false);
  });

  it("requires a chain anchor to name its row position", () => {
    const baseChain = { type: "chain", category: "questionable_grade", id: "QS. 2:255" };
    expect(v.is(FeedbackAnchorSchema, baseChain)).toBe(false);
    expect(v.is(FeedbackAnchorSchema, { ...baseChain, chainIndex: -1 })).toBe(false);
    expect(v.is(FeedbackAnchorSchema, { ...baseChain, chainIndex: 1.5 })).toBe(false);
    expect(v.is(FeedbackAnchorSchema, { ...baseChain, chainIndex: 0 })).toBe(true);
  });

  it("rejects unknown anchor types and unknown categories", () => {
    expect(
      v.is(FeedbackAnchorSchema, { type: "answer", category: "wrong_citation", id: "x" }),
    ).toBe(false);
    expect(v.is(FeedbackAnchorSchema, { type: "chunk", category: "spam", id: "chunk-1" })).toBe(
      false,
    );
  });

  it("rejects an anchor with an empty id", () => {
    expect(
      v.is(
        FeedbackRequestSchema,
        base({
          rating: undefined,
          anchor: { type: "chunk", category: "irrelevant_chunk", id: "" },
        }),
      ),
    ).toBe(false);
  });

  it("rejects a non-uuid messageId", () => {
    expect(v.is(FeedbackRequestSchema, base({ messageId: "msg1" }))).toBe(false);
  });

  it("rejects free text beyond the cap", () => {
    const long = "a".repeat(2001);
    expect(v.is(FeedbackRequestSchema, base({ freeText: long }))).toBe(false);
  });
});

/**
 * The free-text field's storability rule: `free_text` is a Postgres `text`
 * column, so the contract refuses the payloads no `text` value can hold —
 * U+0000 and an unpaired surrogate — before the route, auth and the store. The
 * rule is the chat message's `STORABLE_TEXT_PATTERN`, reused rather than
 * restated, so the two fields cannot drift apart.
 *
 * Storability, not "is a control", is the line: a control the store can hold
 * stays accepted free text.
 */
describe("FeedbackRequestSchema free text storability (#510)", () => {
  const MESSAGE_ID = "0b8fe2a5-6b1a-4d0e-9a7c-1f2e3d4c5b6a";
  const thumb = (freeText: unknown) => ({ messageId: MESSAGE_ID, rating: "up", freeText });
  const flag = (freeText: unknown) => ({
    messageId: MESSAGE_ID,
    anchor: { type: "chunk", category: "irrelevant_chunk", id: "chunk-1" },
    freeText,
  });
  const accepts = (freeText: unknown) =>
    v.safeParse(FeedbackRequestSchema, thumb(freeText)).success &&
    v.safeParse(FeedbackRequestSchema, flag(freeText)).success;

  it("rejects U+0000 on both shapes, anywhere in the free text", () => {
    for (const freeText of ["\u0000", "\u0000riba", "riba\u0000", "a\u0000b"]) {
      expect(v.safeParse(FeedbackRequestSchema, thumb(freeText)).success).toBe(false);
      expect(v.safeParse(FeedbackRequestSchema, flag(freeText)).success).toBe(false);
    }
  });

  it("rejects an unpaired surrogate on both shapes", () => {
    for (const freeText of ["\ud800", "ri\ud800ba", "riba\ud800", "\udc00", "riba\udc00"]) {
      expect(v.safeParse(FeedbackRequestSchema, thumb(freeText)).success).toBe(false);
      expect(v.safeParse(FeedbackRequestSchema, flag(freeText)).success).toBe(false);
    }
  });

  it("still accepts a well-formed surrogate pair (an emoji is free text)", () => {
    for (const freeText of ["😀", "\ud83d\ude00", "tidak relevan 😀"]) {
      expect(accepts(freeText)).toBe(true);
    }
  });

  it("still accepts the control characters the store can hold, and empty text", () => {
    for (const freeText of ["", "\u0001\u0007", "\u007f", "\u200b", "   ", "؟!؟"]) {
      expect(accepts(freeText)).toBe(true);
    }
  });

  it("keeps the free-text cap on both shapes", () => {
    expect(accepts("a".repeat(2000))).toBe(true);
    expect(accepts("a".repeat(2001))).toBe(false);
  });

  /**
   * Raw UTF-16 code units, so unpaired surrogates and U+0000 are in the input
   * space rather than a hand-picked list, plus texts straddling the cap.
   */
  const codeUnitsArb = fc
    .array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 24 })
    .map((units) => String.fromCharCode(...units));

  const lengthArb = fc.integer({ min: 1995, max: 2005 }).map((length) => "a".repeat(length));

  fcTest.prop([fc.oneof(codeUnitsArb, lengthArb)])(
    "admits exactly the storable texts within the cap, on both shapes",
    (freeText) => {
      const storable = freeText.length <= 2000 && isStorableText(freeText);
      expect(v.safeParse(FeedbackRequestSchema, thumb(freeText)).success).toBe(storable);
      expect(v.safeParse(FeedbackRequestSchema, flag(freeText)).success).toBe(storable);
    },
  );

  it("draws both verdicts, so the law above is not vacuous", () => {
    const sample = fc.sample(codeUnitsArb, { numRuns: 500, seed: 0x510 });
    expect(sample.some((text) => accepts(text))).toBe(true);
    expect(sample.some((text) => !accepts(text))).toBe(true);
    expect(sample.some((text) => !isStorableText(text))).toBe(true);
  });
});
