import { describe, expect, it } from "vitest";
import { MAX_PREFILL_LENGTH, parsePrefill, validateChatSearch } from "./chat-prefill";

/**
 * The chat route's `?q=` pre-fill parsing (#175). The load-bearing pin: an
 * unusable param — absent, empty, whitespace-only, not a string, or over the
 * length cap — is IGNORED (never seeds, never errors), and a usable one is
 * trimmed. A future change that lets an over-long value through, or turns an
 * out-of-range one into a route error, trips here.
 */

describe("parsePrefill", () => {
  it("returns a usable question, trimmed", () => {
    expect(parsePrefill("  What does the Quran say about patience?  ")).toBe(
      "What does the Quran say about patience?",
    );
    expect(parsePrefill("Apa yang Al-Qur'an katakan tentang kesabaran?")).toBe(
      "Apa yang Al-Qur'an katakan tentang kesabaran?",
    );
  });

  it("ignores anything that is not a usable question", () => {
    for (const raw of [
      undefined,
      null,
      "",
      "   ",
      123,
      true,
      {},
      [],
      "x".repeat(MAX_PREFILL_LENGTH + 1),
    ]) {
      expect(parsePrefill(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });

  it("accepts a question exactly at the length cap", () => {
    const atCap = "x".repeat(MAX_PREFILL_LENGTH);
    expect(parsePrefill(atCap)).toBe(atCap);
  });

  it("keeps a question under the cap intact", () => {
    const question = "Hadits shahih apa saja yang berbicara tentang kesabaran?";
    expect(question.length).toBeLessThanOrEqual(MAX_PREFILL_LENGTH);
    expect(parsePrefill(question)).toBe(question);
  });
});

describe("validateChatSearch", () => {
  it("maps a usable q to the seed and trims it", () => {
    expect(validateChatSearch({ q: "  Apa itu ayat kursi?  " })).toEqual({
      q: "Apa itu ayat kursi?",
    });
  });

  it("clears an unusable q to an explicit undefined — never an error", () => {
    // The key is always emitted (see the function's comment): omitting it would
    // leave the raw value readable, because the router merges the validated
    // object over the raw search.
    for (const input of [
      {},
      { q: "" },
      { q: "   " },
      { q: 123 },
      { q: undefined },
      { q: "x".repeat(MAX_PREFILL_LENGTH + 1) },
    ]) {
      expect(() => validateChatSearch(input)).not.toThrow();
      const output = validateChatSearch(input);
      // The key must be present with an explicit undefined — JSON.stringify
      // drops undefined values, so a string comparison would mask a regression
      // of the always-emit invariant (thermo-review B2).
      expect("q" in output, JSON.stringify(input)).toBe(true);
      expect(output.q, JSON.stringify(input)).toBeUndefined();
    }
  });

  it("drops every other param, keeping only the validated q", () => {
    const output = validateChatSearch({ q: "Apa itu ayat kursi?", extra: "keep-out" });
    expect(output.q).toBe("Apa itu ayat kursi?");
    expect("extra" in output).toBe(false);
  });
});
