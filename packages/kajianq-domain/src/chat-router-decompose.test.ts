import { describe, expect, it } from "vite-plus/test";
import { decomposeQuery, MAX_SUB_QUERIES, MIN_SUB_QUERIES } from "./chat-router-decompose";

/**
 * Query decomposition's deterministic half (spec §3.3 stage 2): the model phrases, the
 * domain guarantees. Every case here is a reply a cheap model actually produces — too
 * few sub-queries, too many, a rule left uncovered, an invented role — and the
 * assertion is always the same shape: the stage's bound holds and every rule that fired
 * is covered.
 */

const QUESTION = "Kenapa shalat orang sakit boleh diringankan?";

const input = (overrides: Partial<Parameters<typeof decomposeQuery>[0]> = {}) => ({
  question: QUESTION,
  needsPrinciple: false,
  principleTags: [],
  modelSubQueries: [],
  ...overrides,
});

/** Text + role: the idempotence law's own shape — provenance is the repair's bookkeeping. */
const shape = (subs: ReturnType<typeof decomposeQuery>) =>
  subs.map((sub) => ({ text: sub.text, role: sub.role }));

/** The repair's own output, handed back as the model's reply: the second pass. */
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

describe("decomposeQuery", () => {
  it("keeps the model's own sub-queries and their roles beside the caller's question", () => {
    const subs = decomposeQuery(
      input({
        modelSubQueries: [
          { text: "hukum shalat orang sakit", role: "factual" },
          { text: "keringanan dalam ibadah", role: "principle" },
        ],
      }),
    );
    expect(subs).toEqual([
      { text: QUESTION, role: "factual", origin: "rule" },
      { text: "hukum shalat orang sakit", role: "factual", origin: "model" },
      { text: "keringanan dalam ibadah", role: "principle", origin: "model" },
    ]);
  });

  it("keeps the caller's question beside a model entry that carries no role", () => {
    const subs = decomposeQuery(input({ modelSubQueries: [{ text: "keringanan shalat" }] }));
    expect(subs).toEqual([
      { text: QUESTION, role: "factual", origin: "rule" },
      { text: "keringanan shalat", origin: "model" },
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

    // A subject area with no rule of its own adds nothing beyond the factual, so the
    // floor put the second entry there and both are labelled `factual`. That repeat is
    // deliberate, not a duplicate: the caller's verbatim question and the model's
    // paraphrase are two different retrieval texts for the same role.
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
    // The `factual` rule's entry is the caller's question, added ahead of the
    // reply; the reply's factual paraphrase is a second distinct text, not a
    // replacement. No rule adds a duplicate: principle and sanad are already
    // labelled by the model.
    expect(subs.map((s) => s.origin)).toEqual(["rule", "model", "model", "model"]);
    expect(subs.map((s) => s.role)).toEqual(["factual", "factual", "principle", "sanad"]);
    expect(subs.map((s) => s.text)).toEqual([
      QUESTION,
      "hukum shalat",
      "prinsip yusr",
      "sanad hadits shalat",
    ]);
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
    // The caller's question and the rule-derived sub-queries survive; the model's
    // extra angles are what the ceiling spends.
    expect(subs.map((s) => s.role)).toEqual(["factual", "principle", "dalil", "factual"]);
    expect(subs[0]).toEqual({ text: QUESTION, role: "factual", origin: "rule" });
    expect(subs.at(-1)).toEqual({ text: "sudut satu", role: "factual", origin: "model" });
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
    expect(subs.map((s) => s.text)).toEqual([QUESTION, "hukum riba"]);
  });

  it("yields the single factual fallback when the reply carried no sub-query at all", () => {
    // With nothing to decompose, the stage routes the verbatim question alone rather
    // than padding with a synthetic near-duplicate that would claim a decomposition
    // never performed.
    const subs = decomposeQuery(input());
    expect(subs).toEqual([{ text: QUESTION, role: "factual", origin: "rule" }]);
  });

  it("drops a role outside the vocabulary but keeps the sub-query's text", () => {
    const subs = decomposeQuery(
      input({ modelSubQueries: [{ text: "hukum riba", role: "tafsir" }] }),
    );
    expect(subs).toEqual([
      { text: QUESTION, role: "factual", origin: "rule" },
      { text: "hukum riba", origin: "model" },
    ]);
  });

  it("keeps one caller entry when the model echoes the question, under any label", () => {
    // The caller's question is already the `factual` rule's own entry, so a reply
    // that echoes it adds no second spelling of the same retrieval text — under no
    // role, a role the vocabulary drops, a different declared role, or `factual`.
    // The label the model put on the duplicate is not published: the entry is the
    // caller's words, and it keeps the rule's origin rather than the model's.
    const Q = "hukum riba?";
    const echo = (entry: { text: string; role?: string }) =>
      decomposeQuery(input({ question: Q, modelSubQueries: [entry] }));

    expect(echo({ text: Q })).toEqual([{ text: Q, role: "factual", origin: "rule" }]);
    expect(echo({ text: Q, role: "tafsir" })).toEqual([
      { text: Q, role: "factual", origin: "rule" },
    ]);
    expect(echo({ text: Q, role: "sanad" })).toEqual([
      { text: Q, role: "factual", origin: "rule" },
    ]);
    expect(echo({ text: Q, role: "factual" })).toEqual([
      { text: Q, role: "factual", origin: "rule" },
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
 * The invariant this suite pins: the caller's question is always one of the texts
 * retrieval runs, whatever the router model phrases on top of it. A paraphrase can
 * land in vocabulary the corpus does not use; the caller's words are the one text
 * known to be phrased for this question. The model's entries stay as additive
 * angles beside it, never as its substitute.
 */
describe("decomposeQuery — the caller's words are always searched", () => {
  const Q = "Apa yang Nabi Islam katakan tentang mencari ilmu?";

  it("keeps the caller's question beside a model paraphrase labelled factual", () => {
    const subs = decomposeQuery(
      input({
        question: Q,
        modelSubQueries: [
          { text: "hadis Nabi tentang keutamaan mencari ilmu طلب العلم", role: "factual" },
          { text: "sanad hadith man salaka tariqan yaltamisu fihi ilman", role: "sanad" },
        ],
      }),
    );
    expect(subs[0]).toEqual({ text: Q, role: "factual", origin: "rule" });
    expect(subs.map((s) => s.text)).toContain(
      "hadis Nabi tentang keutamaan mencari ilmu طلب العلم",
    );
    // Both model phrasings survive the repair beside the caller's words.
    expect(subs.filter((s) => s.origin === "model")).toHaveLength(2);
  });

  it("keeps the caller's words in the set when the cap forces a choice", () => {
    const subs = decomposeQuery(
      input({
        question: Q,
        category: "hadith",
        modelSubQueries: [
          { text: "keutamaan menuntut ilmu", role: "factual" },
          { text: "kewajiban menuntut ilmu bagi muslim", role: "factual" },
          { text: "hadis ilmu ibnu majah", role: "factual" },
          { text: "sanad hadis menuntut ilmu", role: "factual" },
        ],
      }),
    );
    expect(subs).toHaveLength(MAX_SUB_QUERIES);
    // The cap drops the model's last paraphrase; the caller's question keeps its
    // slot, and the `sanad` rule keeps the one its coverage is owed.
    expect(subs[0]).toEqual({ text: Q, role: "factual", origin: "rule" });
    expect(subs.some((s) => s.role === "sanad" && s.origin === "rule")).toBe(true);
    expect(subs.map((s) => s.text)).not.toContain("sanad hadis menuntut ilmu");
  });

  it("stays a fixed point with the caller's entry in the set", () => {
    const source = input({
      question: Q,
      category: "hadith",
      modelSubQueries: [
        { text: "hadis Nabi tentang keutamaan mencari ilmu طلب العلم", role: "factual" },
        { text: "sanad hadith man salaka tariqan yaltamisu fihi ilman", role: "sanad" },
      ],
    });
    const subs = decomposeQuery(source);
    expect(again(source, subs)).toEqual(shape(subs));
  });
});

/**
 * The law `decomposeQuery is idempotent over the sub-queries it produced` holds only if
 * the fan-out keeps both of these:
 *
 *   1. every reply text is tested for content, so a punctuation-only `"!"` or a lone
 *      quote is never embedded and searched;
 *   2. the ceiling never spends the slot of the entry a fired rule's own text lives
 *      in, so the next pass cannot re-add that rule's entry — at a different position
 *      — and change the answer.
 *
 * Every case below is one of those, plus the boundary in the other direction: trimming
 * and dropping must not cost a short, numeric or non-Latin sub-query its place in the
 * fan-out.
 */
describe("decomposeQuery — what it keeps from the reply (#450)", () => {
  const Q = "hukum riba?";

  it("drops the reply's texts that carry nothing to search with", () => {
    // The reply's junk, with the neighbours that look similar and must all go too:
    // whitespace, punctuation, a lone quote, a dash run, an emoji (a surrogate pair), a
    // control character. Each one would be an embed and a pair of searches spent on a
    // query that cannot retrieve. The reply phrased nothing searchable, so what is left
    // is the caller's question under the `factual` rule.
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
    // The failure an ASCII content test would introduce, and the reason the content test
    // is a Unicode property rather than `/[a-z0-9]/i`: an ASCII reading drops every one
    // of these, and a dropped sub-query narrows retrieval silently — the angle is gone
    // from the fan-out and nothing on the trace says so.
    const kept = (text: string) =>
      decomposeQuery(input({ question: Q, modelSubQueries: [{ text, role: "sanad" }] })).map(
        (sub) => sub.text,
      );

    expect(kept("riba")).toEqual([Q, "riba"]); // one word
    expect(kept("5")).toEqual([Q, "5"]); // one numeral
    expect(kept("٥")).toEqual([Q, "٥"]); // an Arabic-Indic numeral
    expect(kept("a")).toEqual([Q, "a"]); // one ASCII letter
    expect(kept("الربا")).toEqual([Q, "الربا"]); // Arabic
    expect(kept("حكم الربا")).toEqual([Q, "حكم الربا"]); // an Arabic phrase
    expect(kept("QS. 2:255")).toEqual([Q, "QS. 2:255"]); // punctuation around content
    expect(kept("riba 🎉")).toEqual([Q, "riba 🎉"]); // an emoji beside content
    expect(kept("\u200briba")).toEqual([Q, "\u200briba"]); // a marker beside content
    expect(kept("dalil")).toEqual([Q, "dalil"]); // a bare role word is still a word
  });

  it("keeps the whitespace-padded text from the counterexample, trimmed", () => {
    // A padded text is legitimate: padding is not content, and the query the model meant
    // is `spaced   text`. Refusing a padded text would be over-normalisation; keeping it
    // untrimmed is what the repair's own idempotence forbids.
    const subs = decomposeQuery(
      input({ question: Q, modelSubQueries: [{ text: "  spaced   text  ", role: "principle" }] }),
    );
    expect(subs.map((sub) => sub.text)).toEqual([Q, "spaced   text"]);
  });

  it("keeps the entry a fired rule's coverage lives in when the ceiling spends its budget", () => {
    // The stand-in path: the reply over-produces and the `sanad` rule's own text
    // arrives under `principle` — a declared role the repair never overwrites, so
    // `sanad` stays uncovered and that entry is the rule's only evidence. The entry
    // repeats `principle`, so it is an extra like `b` and `c`; the ceiling keeps it
    // anyway, ahead of both, or the budget is spent on them and the rule's text is
    // gone. That is also why the second pass must keep the same set: a dropped
    // stand-in makes the next pass re-add the `sanad` entry and change the answer.
    const source = input({
      question: Q,
      category: "hadith",
      modelSubQueries: [
        { text: "a", role: "principle" },
        { text: "b", role: "principle" },
        { text: "c", role: "principle" },
        { text: "sanad dan derajat hadis tentang: hukum riba?", role: "principle" },
      ],
    });
    const subs = decomposeQuery(source);
    expect(subs).toEqual([
      { text: Q, role: "factual", origin: "rule" },
      { text: "a", role: "principle", origin: "model" },
      { text: "sanad dan derajat hadis tentang: hukum riba?", role: "principle", origin: "model" },
      { text: "b", role: "principle", origin: "model" },
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
      { text: Q, role: "factual", origin: "rule" },
      { text: "hukum riba", role: "sanad", origin: "model" },
      { text: "spaced   text", role: "principle", origin: "model" },
    ]);
    expect(again(source, subs)).toEqual(shape(subs));
  });

  it("drops the caller's content-free question together with the reply's echo of it", () => {
    // The drop is a function of the TEXT alone, so the caller's own question is not
    // exempt from it: the `factual` rule's text *is* the verbatim question, and a
    // question carrying no letter and no digit is not a retrieval query. A reply that
    // still phrased something searchable routes on that alone.
    const source = input({
      question: "!!",
      modelSubQueries: [{ text: "x", role: "sanad" }],
    });
    const subs = decomposeQuery(source);
    expect(subs).toEqual([{ text: "x", role: "sanad", origin: "model" }]);
    expect(again(source, subs)).toEqual(shape(subs));

    // The reply's echo of the content-free question goes with it, so both arms of the
    // drop agree on the next pass and nothing is left to fan out over.
    expect(decomposeQuery(input({ question: "!!", modelSubQueries: [{ text: "!!" }] }))).toEqual(
      [],
    );
  });

  it("leaves nothing to search when the question is blank and the reply phrased no text", () => {
    expect(
      decomposeQuery(input({ question: "   ", modelSubQueries: [{ text: "!", role: "dalil" }] })),
    ).toEqual([]);
  });
});

/** The stage's own content test, restated: a letter or a digit in any script. */
const hasContent = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);

/**
 * The invariant this suite pins: **a text that carries no letter and no digit in any
 * script never becomes a sub-query, whatever its origin** — the reply's text or a rule's
 * own text. The rule loop and the floor take the same gate the reply's texts take, and
 * the trim alone cannot enforce it: `normalize` trims ECMAScript **White_Space**, which
 * the `Cf` zero-width space and joiner and the `Cc` C0 controls are not (a BOM, U+FEFF,
 * *is* ECMAScript White_Space, so `trim()` alone already caught that one).
 *
 * It fails silently: no error, no refusal difference, only an embed slot, a pair of
 * searches and a Trace entry spent on a text that cannot retrieve.
 */
describe("decomposeQuery — a text with no letter and no digit is never a sub-query (#462)", () => {
  /** The two content-free questions, verbatim. */
  const ZERO_WIDTH_QUESTION = "\u200b\u200d\u200b"; // hex e2808be2808de2808b
  const CONTROL_QUESTION = "\u0001\u0007"; // hex 0107

  /**
   * The class the content test has to reach, beyond the two questions above: `Cf` on
   * its own (a zero-width space, a joiner, a word joiner, a BOM), `Cc` on its own, and
   * the ASCII/other-script punctuation the reply leg already dropped. Blank and
   * whitespace-only are in here too: they must keep producing no sub-query.
   */
  const CONTENT_FREE_QUESTIONS = [
    ZERO_WIDTH_QUESTION,
    CONTROL_QUESTION,
    "\u200b",
    "\u200d",
    "\u2060",
    "\ufeff",
    "!!",
    "؟",
    "🎉🎉",
    "   ",
    "\t\n",
  ] as const;

  it("fans out over nothing for the zero-width question, with or without the reply's echo", () => {
    // The shape: `needsPrinciple: false` and no fikih/hadith category, so the `factual`
    // rule is the only one that fired and its text *is* this content-free question. This
    // pins the pure decomposer's range for such a question; on the serving path the route
    // declines it before this stage (`chat-router.ts`), so a route's empty fan-out is the
    // gate's, never this function's. A shape that fires a rule beyond `factual` keeps that
    // rule's template entry; that other half is pinned by the template test below. The
    // rule's own add: no reply at all.
    expect(decomposeQuery(input({ question: ZERO_WIDTH_QUESTION }))).toEqual([]);
    // The reply's echo of it: both arms drop this text, so the two passes agree and the
    // rule cannot re-add it lower down the fan-out.
    expect(
      decomposeQuery(
        input({ question: ZERO_WIDTH_QUESTION, modelSubQueries: [{ text: ZERO_WIDTH_QUESTION }] }),
      ),
    ).toEqual([]);
    // The echo under a declared role, and the floor's arm: still nothing.
    expect(
      decomposeQuery(
        input({
          question: ZERO_WIDTH_QUESTION,
          modelSubQueries: [{ text: ZERO_WIDTH_QUESTION, role: "factual" }],
        }),
      ),
    ).toEqual([]);
  });

  it("fans out over nothing for the control-character question, with or without the reply's echo", () => {
    // Same shape as the zero-width case above: the `factual` rule alone fired.
    expect(decomposeQuery(input({ question: CONTROL_QUESTION }))).toEqual([]);
    expect(
      decomposeQuery(
        input({ question: CONTROL_QUESTION, modelSubQueries: [{ text: CONTROL_QUESTION }] }),
      ),
    ).toEqual([]);
    expect(
      decomposeQuery(
        input({
          question: CONTROL_QUESTION,
          modelSubQueries: [{ text: CONTROL_QUESTION, role: "sanad" }],
        }),
      ),
    ).toEqual([]);
  });

  it("returns no sub-query whose text carries no letter and no digit, whatever its origin", () => {
    // The invariant over the real stage rather than a stub: every entry of every
    // fan-out below carries `\p{L}`/`\p{N}` in some script. Each content-free
    // question is crossed with the reply shapes that could smuggle it back in —
    // an echo with no role (the rule stamps its role onto that entry), an echo
    // labelled `factual`, an echo under another declared role, a reply that
    // phrased something searchable, and the rule's own template built on it.
    for (const question of CONTENT_FREE_QUESTIONS) {
      const replies: { text: string; role?: string }[][] = [
        [],
        [{ text: question }],
        [{ text: question, role: "factual" }],
        [{ text: "hukum riba", role: "sanad" }],
        [{ text: `dalil Al-Quran tentang: ${question}`, role: "dalil" }],
      ];
      for (const modelSubQueries of replies) {
        for (const sub of decomposeQuery(input({ question, modelSubQueries }))) {
          expect(hasContent(sub.text)).toBe(true);
        }
      }
    }
  });

  it("keeps every content-bearing text that arrives beside a content-free question", () => {
    // The boundary in the other direction: dropping a content-free text must not cost a
    // searchable one its place. `5`, `٥`, `５`, `الربا`, `حكم ربا` and `漢字` all carry
    // `\p{L}`/`\p{N}`.
    for (const text of ["5", "٥", "５", "الربا", "حكم ربا", "漢字"]) {
      const subs = decomposeQuery(
        input({ question: ZERO_WIDTH_QUESTION, modelSubQueries: [{ text, role: "sanad" }] }),
      );
      expect(subs).toEqual([{ text, role: "sanad", origin: "model" }]);
    }
  });

  it("keeps a rule's own template when the template's words carry the content", () => {
    // The content test is on the text, not on the question it was built from, and
    // this is the boundary that follows: the `factual` rule's text is the bare
    // question, so it is dropped, while the principle/dalil/sanad templates carry
    // their own words ("prinsip … dalam menjawab") and stay searchable. Asserted
    // rather than left implicit, because it is a deliberate reading of the
    // invariant — "a text that carries no letter and no digit" — and not an
    // accident of which rule fired.
    expect(decomposeQuery(input({ question: ZERO_WIDTH_QUESTION, needsPrinciple: true }))).toEqual([
      {
        text: `prinsip syariat dalam menjawab: ${ZERO_WIDTH_QUESTION}`,
        role: "principle",
        origin: "rule",
      },
    ]);
  });

  it("is idempotent over the two probes", () => {
    // The drop is a function of the text alone, so the second pass — handed the first
    // pass's (empty) output as the reply — agrees with it; the idempotence law is the
    // property form of this.
    for (const question of [ZERO_WIDTH_QUESTION, CONTROL_QUESTION]) {
      const source = input({ question, modelSubQueries: [{ text: question }] });
      expect(again(source, decomposeQuery(source))).toEqual(shape(decomposeQuery(source)));
    }
  });
});
