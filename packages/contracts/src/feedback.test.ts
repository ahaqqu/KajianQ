import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  FeedbackAnchorSchema,
  FeedbackRequestSchema,
  type FeedbackRequest,
} from "./feedback";

/**
 * Feedback contracts (#13). These are trap tests: the anchor taxonomy only
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
  });

  it("rejects unknown anchor types and unknown categories", () => {
    expect(v.is(FeedbackAnchorSchema, { type: "answer", category: "wrong_citation", id: "x" })).toBe(
      false,
    );
    expect(v.is(FeedbackAnchorSchema, { type: "chunk", category: "spam", id: "chunk-1" })).toBe(
      false,
    );
  });

  it("rejects an anchor with an empty id", () => {
    expect(
      v.is(FeedbackRequestSchema, base({ rating: undefined, anchor: { type: "chunk", category: "irrelevant_chunk", id: "" } })),
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
