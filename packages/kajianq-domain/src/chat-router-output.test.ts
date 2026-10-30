import { describe, expect, it } from "vite-plus/test";
import { readRouterReply, readRouterText } from "./chat-router-output";

/**
 * Reading the router LLM's reply. The model's values are free strings, so
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
    expect(reading?.madzhab).toBe("syafii");
    expect(reading?.textLayer).toBe("matn");
    expect(reading?.needsPrinciple).toBe(true);
    expect(reading?.principleTags).toEqual(["yusr", "rahmah"]);
    // Only the corpus-backed dimensions become filters. Madzhab, TextLayer and
    // Principle are classifications: the corpus carries no row for their keys,
    // so a filter on one could never match.
    expect(reading?.filters).toEqual({ grade: ["sahih"] });
    expect(reading?.confidence).toBe(0.82);
    expect(reading?.reasoning).toBe("the question asks why the rule is lenient");
    expect(reading?.modelSubQueries).toEqual([
      { text: "hukum shalat orang sakit", role: "factual" },
      { text: "prinsip kemudahan dalam ibadah", role: "principle" },
    ]);
    expect(reading?.attributes).toEqual({
      needsPrinciple: true,
      category: "fikih",
      madzhab: "syafii",
      textLayer: "matn",
      principleTags: ["yusr", "rahmah"],
      grade: ["sahih"],
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

  it("drops classification hints outside their vocabularies", () => {
    const reading = reply({ madzhab: "shafi'i", grade: "daif", textLayer: "commentary" });
    expect(reading?.filters).toEqual({});
    expect(reading?.madzhab).toBeUndefined();
    expect(reading?.textLayer).toBeUndefined();
    expect(reading?.attributes).toEqual({ needsPrinciple: false, category: "fikih" });
  });

  it("records the Madzhab and TextLayer classifications without making them filters", () => {
    // The ruling keeps the router's classification as trace value; the corpus
    // carries no row for either key, so neither may become a constraint.
    const reading = reply({ madzhab: "syafii", textLayer: "matn" });
    expect(reading?.filters).toEqual({});
    expect(reading?.attributes).toMatchObject({ madzhab: "syafii", textLayer: "matn" });
    expect(reading?.attributes).not.toHaveProperty("grade");
  });

  it("lets the caller's explicit filters win over the model's hints", () => {
    const reading = readRouterReply(
      { intent: "ruling", category: "fikih", grade: "hasan" } as never,
      { grade: ["sahih"] },
    );
    expect(reading?.filters).toEqual({ grade: ["sahih"] });
    expect(reading?.attributes).toMatchObject({ grade: ["sahih"] });
  });

  it("reads a per-chain grade hint into its own filter dimension", () => {
    const reading = reply({ chainGrade: "sahih" });
    expect(reading?.filters).toEqual({ chainGrade: ["sahih"] });
    expect(reading?.attributes).toMatchObject({ chainGrade: ["sahih"] });
    // The flat grade stays absent: a chain hint must not constrain the passage's
    // headline grade, and vice versa.
    expect(reading?.filters).not.toHaveProperty("grade");
  });

  it("drops an out-of-vocabulary chain grade and keeps the reply usable", () => {
    for (const chainGrade of ["daif", "sahihh", "", 3]) {
      const reading = reply({ chainGrade });
      expect(reading?.filters).toEqual({});
      expect(reading?.attributes).not.toHaveProperty("chainGrade");
      expect(reading?.intent).toBe("ruling");
    }
  });

  it("keeps the flat grade and the chain grade as separate dimensions", () => {
    const reading = reply({ grade: "sahih", chainGrade: "dhaif" });
    expect(reading?.filters).toEqual({ grade: ["sahih"], chainGrade: ["dhaif"] });
  });

  it("lets the caller's chain-grade pin win over the model's hint", () => {
    const reading = readRouterReply(
      { intent: "ruling", category: "fikih", chainGrade: "hasan" } as never,
      { chainGrade: ["sahih"] },
    );
    expect(reading?.filters).toEqual({ chainGrade: ["sahih"] });
    expect(reading?.attributes).toMatchObject({ chainGrade: ["sahih"] });
  });

  it("keeps a caller key outside the filter vocabulary for the store mapping to reject", () => {
    // The reader does not silently drop an unknown key: it rides into
    // `filters`, where `filterEntries` raises `FilterNotExpressibleError`
    // before a search runs. Dropping it here would reproduce the silent
    // constraint drop the filter map exists to prevent.
    const reading = readRouterReply(
      { intent: "ruling" } as never,
      {
        madzhab: ["syafii"],
      } as never,
    );
    expect(reading?.filters).toHaveProperty("madzhab", ["syafii"]);
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
