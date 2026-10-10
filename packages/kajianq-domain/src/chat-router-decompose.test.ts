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

  it("stamps the fired rule's role onto a role-less echo of the question", () => {
    // The class the property generator cannot reach (review R2-A1): the model's
    // only sub-query *is* the question, so the `factual` rule's own text
    // collides with it. Without the stamp the rule's entry is dropped by the
    // duplicate filter and the Trace shows a route it cannot explain.
    const Q = "hukum riba?";
    const echo = (entry: { text: string; role?: string }) =>
      decomposeQuery(input({ question: Q, modelSubQueries: [entry] }));

    // No role at all, and a role the vocabulary drops: both reach the rule
    // role-less, so both take the stamp. Text and `model` origin stand — the
    // model phrased it, the rule labelled it.
    expect(echo({ text: Q })).toEqual([{ text: Q, role: "factual", origin: "model" }]);
    expect(echo({ text: Q, role: "tafsir" })).toEqual([
      { text: Q, role: "factual", origin: "model" },
    ]);

    // A *different* declared role is the model's own label and is never
    // overwritten — the exception the module header states: the `factual` rule
    // goes unshown rather than the model's claim being rewritten.
    expect(echo({ text: Q, role: "sanad" })).toEqual([{ text: Q, role: "sanad", origin: "model" }]);

    // Control: the model labelled the echo `factual` itself; nothing to stamp.
    expect(echo({ text: Q, role: "factual" })).toEqual([
      { text: Q, role: "factual", origin: "model" },
    ]);
  });

  it("has nothing to search for a whitespace-only question with no usable reply", () => {
    // The HTTP contract accepts a whitespace-only body inside the ceiling, so
    // the stage must not invent a sub-query out of it: an empty decomposition
    // leaves retrieval empty, and the answer path refuses rather than crashing
    // on a Trace event with blank text.
    expect(decomposeQuery(input({ question: "   " }))).toEqual([]);
  });
});

/**
 * #450. The law `decomposeQuery is idempotent over the sub-queries it produced`
 * failed on a share of seeds, so `gate` reddened on PRs whose diff had nothing to
 * do with the router. Two defects were behind it, and only one of them is junk:
 *
 *   1. the reply's texts reached the fan-out untested for content, so a
 *      punctuation-only `"!"` or a lone quote was embedded and searched;
 *   2. the ceiling could spend the slot of the entry a fired rule's own text
 *      lived in, so the next pass re-added that rule's entry — at a different
 *      position — and the answer changed.
 *
 * Every case below is one of those, plus the boundary in the other direction:
 * trimming and refusing must not cost a short, numeric or non-Latin sub-query
 * its place in the fan-out.
 */
describe("decomposeQuery — what it keeps from the reply (#450)", () => {
  const Q = "hukum riba?";

  /** Text + role: the law's own shape — provenance is the repair's bookkeeping. */
  const shape = (subs: ReturnType<typeof decomposeQuery>) =>
    subs.map((sub) => ({ text: sub.text, role: sub.role }));

  /** The repair's own output, handed back as the model's reply. */
  const again = (
    source: Parameters<typeof decomposeQuery>[0],
    subs: ReturnType<typeof decomposeQuery>,
  ) =>
    shape(
      decomposeQuery({
        ...source,
        modelSubQueries: subs.map((sub) => ({
          text: sub.text,
          ...(sub.role !== undefined ? { role: sub.role } : {}),
        })),
      }),
    );

  it("refuses the reply's texts that carry nothing to search with", () => {
    // The CI counterexample's junk, with the neighbours that look similar and
    // must all go too: whitespace, punctuation, a lone quote, a dash run, an
    // emoji (a surrogate pair), a control character. Each one would be an embed
    // and a pair of searches spent on a query that cannot retrieve. The reply
    // phrased nothing searchable, so what is left is the caller's question under
    // the `factual` rule.
    expect(
      decomposeQuery(
        input({
          question: Q,
          modelSubQueries: [
            { text: "", role: "dalil" },
            { text: "   ", role: "principle" },
            { text: "\t\n", role: "sanad" },
            { text: "!", role: "dalil" },
            { text: '"', role: "principle" },
            { text: "—…?!", role: "principle" },
            { text: "\u0000\u0007", role: "dalil" },
            { text: "🎉🎉", role: "principle" },
          ],
        }),
      ),
    ).toEqual([{ text: Q, role: "factual", origin: "rule" }]);

    // A zero-width space is not whitespace to `trim`, so it is the content test
    // that has to catch it.
    expect(
      decomposeQuery(input({ question: Q, modelSubQueries: [{ text: "\u200b", role: "dalil" }] })),
    ).toEqual([{ text: Q, role: "factual", origin: "rule" }]);
  });

  it("keeps a short, numeric or non-Latin sub-query: content is a letter or a digit, in any script", () => {
    // The failure this fix could introduce, and the reason the content test is a
    // Unicode property rather than `/[a-z0-9]/i`: an ASCII reading drops every
    // one of these, and a dropped sub-query narrows retrieval silently — the
    // angle is gone from the fan-out and nothing on the trace says so.
    const kept = (text: string) =>
      decomposeQuery(input({ question: Q, modelSubQueries: [{ text, role: "sanad" }] })).map(
        (sub) => sub.text,
      );

    expect(kept("riba")).toEqual(["riba", Q]); // one word
    expect(kept("5")).toEqual(["5", Q]); // one numeral
    expect(kept("٥")).toEqual(["٥", Q]); // an Arabic-Indic numeral
    expect(kept("a")).toEqual(["a", Q]); // one ASCII letter
    expect(kept("الربا")).toEqual(["الربا", Q]); // Arabic
    expect(kept("حكم الربا")).toEqual(["حكم الربا", Q]); // an Arabic phrase
    expect(kept("QS. 2:255")).toEqual(["QS. 2:255", Q]); // punctuation around content
    expect(kept("riba 🎉")).toEqual(["riba 🎉", Q]); // an emoji beside content
    expect(kept("\u200briba")).toEqual(["\u200briba", Q]); // a marker beside content
    expect(kept("dalil")).toEqual(["dalil", Q]); // a bare role word is still a word
  });

  it("keeps the whitespace-padded text from the counterexample, trimmed", () => {
    // The third text CI printed is legitimate: padding is not content, and the
    // query the model meant is `spaced   text`. Refusing a padded text would be
    // over-normalisation; keeping it untrimmed is what the repair's own
    // idempotence forbids.
    const subs = decomposeQuery(
      input({ question: Q, modelSubQueries: [{ text: "  spaced   text  ", role: "principle" }] }),
    );
    expect(subs.map((sub) => sub.text)).toEqual(["spaced   text", Q]);
  });

  it("keeps the entry a fired rule's coverage lives in when the ceiling spends its budget", () => {
    // The junk-free half of #450, and the reason the content test alone is not
    // the fix. The reply echoed the question under `sanad` and over-produced, so
    // the ceiling used to spend the echo's slot on a duplicate-role extra. The
    // rule's own text went with it, and the next pass re-added the `factual`
    // entry at the front — the law reddening on an input with nothing to trim.
    const source = input({
      question: Q,
      modelSubQueries: [
        { text: "a", role: "principle" },
        { text: "x", role: "principle" },
        { text: "b", role: "dalil" },
        { text: "c", role: "sanad" },
        { text: Q, role: "sanad" },
      ],
    });
    const subs = decomposeQuery(source);
    expect(subs).toEqual([
      { text: "a", role: "principle", origin: "model" },
      { text: "b", role: "dalil", origin: "model" },
      { text: "c", role: "sanad", origin: "model" },
      { text: Q, role: "sanad", origin: "model" },
    ]);
    // The headline law as an example: the second pass keeps the same set.
    expect(again(source, subs)).toEqual(shape(subs));
  });

  it("is idempotent over the CI counterexample's reply", () => {
    const source = input({
      question: Q,
      modelSubQueries: [
        { text: "!", role: "dalil" },
        { text: "hukum riba", role: "sanad" },
        { text: "  spaced   text  ", role: "principle" },
        { text: Q, role: "sanad" },
        { text: '"', role: "principle" },
      ],
    });
    const subs = decomposeQuery(source);
    expect(subs).toEqual([
      { text: "hukum riba", role: "sanad", origin: "model" },
      { text: "spaced   text", role: "principle", origin: "model" },
      { text: Q, role: "sanad", origin: "model" },
    ]);
    expect(again(source, subs)).toEqual(shape(subs));
  });

  it("never refuses the caller's own question, even when it carries no letter or digit", () => {
    // The refusal is the reply's, not the caller's: the `factual` rule's text is
    // the question itself, and a rule adds it back whether or not the reply
    // phrased it — so refusing it here is not a saving, only a re-ordering.
    const source = input({
      question: "!!",
      modelSubQueries: [{ text: "x", role: "sanad" }],
    });
    const subs = decomposeQuery(source);
    expect(subs).toEqual([
      { text: "x", role: "sanad", origin: "model" },
      { text: "!!", role: "factual", origin: "rule" },
    ]);
    expect(again(source, subs)).toEqual(shape(subs));

    // And the reply's echo of it is still one entry, stamped by the rule rather
    // than duplicated beside it.
    expect(decomposeQuery(input({ question: "!!", modelSubQueries: [{ text: "!!" }] }))).toEqual([
      { text: "!!", role: "factual", origin: "model" },
    ]);
  });

  it("leaves nothing to search when the question is blank and the reply phrased no text", () => {
    expect(
      decomposeQuery(input({ question: "   ", modelSubQueries: [{ text: "!", role: "dalil" }] })),
    ).toEqual([]);
  });
});
