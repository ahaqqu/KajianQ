import { describe, expect, it } from "vitest";
import { decomposeQuery, MAX_SUB_QUERIES, MIN_SUB_QUERIES } from "./chat-router-decompose";

/**
 * Query decomposition's deterministic half (#14, spec §3.3 stage 2): the model
 * phrases, the domain guarantees. Every case here is a reply a cheap model
 * actually produces — too few sub-queries, too many, a rule left uncovered, an
 * invented role — and the assertion is always the same shape: the stage's
 * bound holds and every rule that fired is covered.
 */

const QUESTION = "Kenapa shalat orang sakit boleh diringankan?";

const input = (overrides: Partial<Parameters<typeof decomposeQuery>[0]> = {}) => ({
  question: QUESTION,
  needsPrinciple: false,
  principleTags: [],
  modelSubQueries: [],
  ...overrides,
});

describe("decomposeQuery", () => {
  it("keeps the model's own sub-queries and their roles", () => {
    const subs = decomposeQuery(
      input({
        modelSubQueries: [
          { text: "hukum shalat orang sakit", role: "factual" },
          { text: "keringanan dalam ibadah", role: "principle" },
        ],
      }),
    );
    expect(subs).toEqual([
      { text: "hukum shalat orang sakit", role: "factual", origin: "model" },
      { text: "keringanan dalam ibadah", role: "principle", origin: "model" },
    ]);
  });

  it("adds the verbatim question when the model labelled no factual sub-query", () => {
    const subs = decomposeQuery(input({ modelSubQueries: [{ text: "keringanan shalat" }] }));
    expect(subs).toEqual([
      { text: "keringanan shalat", origin: "model" },
      { text: QUESTION, role: "factual", origin: "rule" },
    ]);
    expect(subs).toHaveLength(MIN_SUB_QUERIES);
  });

  it("adds a principle sub-query when the question needs a lens", () => {
    const subs = decomposeQuery(
      input({
        needsPrinciple: true,
        principleTags: ["yusr", "rahmah"],
        modelSubQueries: [
          { text: "hukum shalat orang sakit", role: "factual" },
          { text: "hadits keringanan shalat", role: "sanad" },
        ],
      }),
    );
    const principle = subs.find((s) => s.role === "principle");
    expect(principle?.origin).toBe("rule");
    expect(principle?.text).toContain("yusr, rahmah");
    expect(principle?.text).toContain(QUESTION);
  });

  it("adds the dalil rule for fikih and the sanad rule for hadith", () => {
    const fikih = decomposeQuery(
      input({ category: "fikih", modelSubQueries: [{ text: "hukum riba", role: "factual" }] }),
    );
    expect(fikih.find((s) => s.role === "dalil")?.origin).toBe("rule");

    const hadith = decomposeQuery(
      input({ category: "hadith", modelSubQueries: [{ text: "hadits wudhu", role: "factual" }] }),
    );
    expect(hadith.find((s) => s.role === "sanad")?.origin).toBe("rule");

    // A subject area with no rule of its own adds nothing beyond the factual —
    // so the floor is what put the second entry there, and both entries are
    // labelled `factual`. That repeat is deliberate, not a duplicate: the
    // caller's verbatim question and the model's paraphrase are two different
    // retrieval texts for the same role, which is exactly what the floor adds
    // (review A2 of the fix round).
    const adab = decomposeQuery(
      input({ category: "adab", modelSubQueries: [{ text: "adab makan", role: "factual" }] }),
    );
    expect(adab.map((s) => s.role)).toEqual(["factual", "factual"]);
  });

  it("never duplicates a rule's sub-query when the model already covered the role", () => {
    const subs = decomposeQuery(
      input({
        needsPrinciple: true,
        principleTags: ["yusr"],
        category: "hadith",
        modelSubQueries: [
          { text: "hukum shalat", role: "factual" },
          { text: "prinsip yusr", role: "principle" },
          { text: "sanad hadits shalat", role: "sanad" },
        ],
      }),
    );
    expect(subs.map((s) => s.origin)).toEqual(["model", "model", "model"]);
  });

  it("keeps the reply inside the bound when the model over-produces", () => {
    const subs = decomposeQuery(
      input({
        needsPrinciple: true,
        principleTags: ["yusr"],
        category: "fikih",
        modelSubQueries: [
          { text: "sudut satu", role: "factual" },
          { text: "sudut dua" },
          { text: "sudut tiga" },
          { text: "sudut empat" },
          { text: "sudut lima" },
        ],
      }),
    );
    expect(subs).toHaveLength(MAX_SUB_QUERIES);
    // The rule-derived sub-queries survive; the model's extra angles are what
    // the ceiling spends.
    expect(subs.map((s) => s.role)).toEqual(["factual", "principle", "dalil", undefined]);
    expect(subs.at(-1)?.text).toBe("sudut dua");
  });

  it("does not let repeated roles crowd out a rule-derived sub-query", () => {
    const subs = decomposeQuery(
      input({
        needsPrinciple: true,
        principleTags: ["yusr"],
        modelSubQueries: [
          { text: "satu", role: "factual" },
          { text: "dua", role: "factual" },
          { text: "tiga", role: "factual" },
          { text: "empat", role: "factual" },
        ],
      }),
    );
    expect(subs).toHaveLength(MAX_SUB_QUERIES);
    // One sub-query per role is what the budget is spent on first, so the
    // rule-derived principle survives and the last extra angle is what goes.
    expect(subs.filter((s) => s.role === "principle")).toHaveLength(1);
    expect(subs.some((s) => s.role === "factual")).toBe(true);
    expect(subs.map((s) => s.text)).not.toContain("empat");
  });

  it("collapses duplicate texts and drops the empty ones", () => {
    const subs = decomposeQuery(
      input({
        modelSubQueries: [
          { text: "hukum riba", role: "factual" },
          { text: "  Hukum   Riba  " },
          { text: "   " },
        ],
      }),
    );
    expect(subs.map((s) => s.text)).toEqual(["hukum riba", QUESTION]);
  });

  it("yields the single factual fallback when the reply carried no sub-query at all", () => {
    // The floor is the model's own reply: with nothing to decompose, the stage
    // routes the verbatim question instead of padding with a synthetic
    // near-duplicate that would claim a decomposition never performed.
    const subs = decomposeQuery(input());
    expect(subs).toEqual([{ text: QUESTION, role: "factual", origin: "rule" }]);
  });

  it("drops a role outside the vocabulary but keeps the sub-query's text", () => {
    const subs = decomposeQuery(
      input({ modelSubQueries: [{ text: "hukum riba", role: "tafsir" }] }),
    );
    expect(subs[0]).toEqual({ text: "hukum riba", origin: "model" });
  });

  it("has nothing to search for a whitespace-only question with no usable reply", () => {
    // The HTTP contract accepts a whitespace-only body inside the ceiling, so
    // the stage must not invent a sub-query out of it: an empty decomposition
    // leaves retrieval empty, and the answer path refuses rather than crashing
    // on a Trace event with blank text.
    expect(decomposeQuery(input({ question: "   " }))).toEqual([]);
  });
});
