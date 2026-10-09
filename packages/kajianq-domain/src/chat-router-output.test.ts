import { describe, expect, it } from "vitest";
import { readRouterReply, readRouterText } from "./chat-router-output";

/**
 * Reading the router LLM's reply (#14). The model's values are free strings, so
 * every assertion here is about what the domain does with a value it did not
 * expect: drop it, keep it, or treat the whole reply as unusable.
 */

const reply = (overrides: Record<string, unknown> = {}) =>
  readRouterReply(
    {
      intent: "ruling",
      category: "fikih",
      ...overrides,
    } as never,
    {},
  );

describe("readRouterText", () => {
  it("reads a full reply into the routing vocabularies", () => {
    const reading = readRouterText(
      JSON.stringify({
        intent: "analogy",
        category: "fikih",
        madzhab: "syafii",
        grade: "sahih",
        textLayer: "matn",
        needsPrinciple: true,
        principleTags: ["yusr", "rahmah"],
        confidence: 0.82,
        reasoning: "  the question asks why the rule is lenient  ",
        subQueries: [
          { text: "hukum shalat orang sakit", role: "factual" },
          { text: "prinsip kemudahan dalam ibadah", role: "principle" },
        ],
      }),
      {},
    );

    expect(reading?.intent).toBe("analogy");
    expect(reading?.category).toBe("fikih");
    expect(reading?.needsPrinciple).toBe(true);
    expect(reading?.principleTags).toEqual(["yusr", "rahmah"]);
    expect(reading?.filters).toEqual({
      madzhab: ["syafii"],
      grade: ["sahih"],
      textLayer: ["matn"],
    });
    expect(reading?.confidence).toBe(0.82);
    expect(reading?.reasoning).toBe("the question asks why the rule is lenient");
    expect(reading?.modelSubQueries).toEqual([
      { text: "hukum shalat orang sakit", role: "factual" },
      { text: "prinsip kemudahan dalam ibadah", role: "principle" },
    ]);
    expect(reading?.attributes).toEqual({
      needsPrinciple: true,
      category: "fikih",
      principleTags: ["yusr", "rahmah"],
      madzhab: ["syafii"],
      grade: ["sahih"],
      textLayer: ["matn"],
    });
  });

  it("returns undefined when the reply carries no JSON object", () => {
    expect(readRouterText("I could not classify this question.", {})).toBeUndefined();
    expect(readRouterText('{"subQueries": []}', {})).toBeUndefined();
    expect(readRouterText("{ not json }", {})).toBeUndefined();
  });

  it("treats an intent outside the vocabulary as an unusable reply", () => {
    // `intent` is what the Trace shows as *the* classification. An invented
    // value must not be recorded as one — the router falls back instead.
    expect(reply({ intent: "dalil_umum" })).toBeUndefined();
    expect(reply({ intent: "" })).toBeUndefined();
  });
});

describe("readRouterReply narrowing", () => {
  it("drops a subject area outside the vocabulary without losing the classification", () => {
    const reading = reply({ category: "fiqh" });
    expect(reading?.category).toBeUndefined();
    expect(reading?.intent).toBe("ruling");
    expect(reading?.attributes).not.toHaveProperty("category");
  });

  it("drops unknown and duplicate Principle tags, and keeps the first three", () => {
    const reading = reply({
      needsPrinciple: true,
      principleTags: ["yusr", "ease", "yusr", "rahmah", "dharar", "istihsan"],
    });
    expect(reading?.principleTags).toEqual(["yusr", "rahmah", "dharar"]);
  });

  it("reads a named Principle tag as needing a lens even without the flag", () => {
    expect(reply({ principleTags: ["rahmah"] })?.needsPrinciple).toBe(true);
    expect(reply({ needsPrinciple: true })?.needsPrinciple).toBe(true);
    expect(reply({})?.needsPrinciple).toBe(false);
  });

  it("drops a confidence that is not a probability, and keeps one that is", () => {
    expect(reply({ confidence: 90 })?.confidence).toBeUndefined();
    expect(reply({ confidence: -0.1 })?.confidence).toBeUndefined();
    expect(reply({ confidence: Number.NaN })?.confidence).toBeUndefined();
    expect(reply({ confidence: 0 })?.confidence).toBe(0);
    expect(reply({ confidence: 1 })?.confidence).toBe(1);
  });

  it("drops a blank rationale and bounds a long one", () => {
    expect(reply({ reasoning: "   " })?.reasoning).toBeUndefined();
    const long = reply({ reasoning: "x".repeat(5000) })?.reasoning ?? "";
    expect(long.length).toBe(600);
  });

  it("drops filter hints outside their vocabularies", () => {
    const reading = reply({ madzhab: "shafi'i", grade: "daif", textLayer: "commentary" });
    expect(reading?.filters).toEqual({});
  });

  it("lets the caller's explicit filters win over the model's hints", () => {
    const reading = readRouterReply(
      { intent: "ruling", category: "fikih", madzhab: "hanafi", grade: "hasan" } as never,
      { madzhab: ["syafii"] },
    );
    expect(reading?.filters).toEqual({ madzhab: ["syafii"], grade: ["hasan"] });
    expect(reading?.attributes).toMatchObject({ madzhab: ["syafii"], grade: ["hasan"] });
  });

  it("accepts a sub-query written as a plain string", () => {
    // The prompt asks for `{text, role}` objects; a model that answers with
    // bare strings still routed the question, so the text is read, not lost.
    const reading = reply({ subQueries: ["hukum riba", { text: "dalil riba", role: "dalil" }] });
    expect(reading?.modelSubQueries).toEqual([
      { text: "hukum riba" },
      { text: "dalil riba", role: "dalil" },
    ]);
  });

  it("carries no sub-queries when the reply omitted them", () => {
    expect(reply({})?.modelSubQueries).toEqual([]);
  });
});
