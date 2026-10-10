import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  decomposeQuery,
  MAX_SUB_QUERIES,
  MIN_SUB_QUERIES,
  type DecompositionInput,
} from "./chat-router-decompose";
import {
  PRINCIPLE_TAGS,
  SUBJECT_AREAS,
  SUB_QUERY_ROLES,
  type SubjectArea,
  type SubQueryRole,
} from "./taxonomy";

/**
 * Reply texts that carry a letter or a digit in some script (#450): one ASCII
 * word, bare numerals, Arabic-Indic and full-width digits, a single Arabic word,
 * Jawi, Han, and punctuation or a zero-width space beside content. The repair's
 * content test must keep every one of them, and only the non-ASCII entries can
 * separate `\p{L}`/`\p{N}` from an ASCII `/[a-z0-9]/i` reading.
 */
const CONTENT_TEXTS = [
  "riba",
  "5",
  "٥",
  "٢٥٥",
  "５",
  "الربا",
  "حكم ربا",
  "漢字",
  "QS. 2:255",
  "\u200briba",
] as const;

/**
 * Texts with no letter and no digit in any script, over the same range of
 * scripts: whitespace, punctuation, symbols, an emoji, control characters, a
 * zero-width space, an Arabic question mark, an Arabic letter mark and an
 * Arabic star. A content-free *non-ASCII* text is what tells a script-agnostic
 * drop apart from an ASCII-only one in the other direction.
 */
const CONTENT_FREE_TEXTS = [
  "",
  "   ",
  "\t\n",
  "!",
  '"',
  "—…?!",
  "\u0000\u0007",
  "🎉🎉",
  "\u200b",
  "؟",
  "\u061c",
  "٭",
  // The `Cf`/`Cc`-only class the rule leg leaked (#462): a zero-width run, a C0
  // control run, a lone joiner, a word joiner and a BOM. `trim()` strips
  // White_Space only, so every one of these survives it — which is why the
  // content test, not the trim, is what has to catch them. The first two are the
  // QA round's measured probes verbatim (a zero-width question and U+0001 U+0007).
  "\u200b\u200d\u200b",
  "\u0001\u0007",
  "\u200d",
  "\u2060",
  "\ufeff",
] as const;

/**
 * The content-free texts a *question* can be (#462): the class the generator
 * could not draw before, and the one the defect lived in. The `factual` rule's
 * own text *is* the caller's question verbatim, so a question carrying no letter
 * and no digit reached the fan-out as `origin: "rule"` and was embedded and
 * searched — one embed slot, a pair of searches and a `subquery` event spent on
 * a text that cannot retrieve. The first two entries are the QA round's probes.
 * Empty is left out: the HTTP boundary refuses a zero-length body, so it is not
 * a question the laws have to reason about (the blank-`"   "` case is drawn
 * beside these, and a blank question has no content either).
 */
const CONTENT_FREE_QUESTION_TEXTS = [
  "\u200b\u200d\u200b",
  "\u0001\u0007",
  "\u200b",
  "\u200d",
  "\u2060",
  "\ufeff",
  "؟",
] as const;

/**
 * The decomposition repair's laws (#14). These are properties, not examples:
 * they must hold for every reply a model can produce — including the adversarial
 * ones (empty text, repeated roles, an invented role, a flood of sub-queries) —
 * because the repair is the only thing standing between a cheap model's reply
 * and the stage's published contract.
 *
 * One `fcTest.prop` case per law, in this order:
 *   1. the ceiling holds: never more than `MAX_SUB_QUERIES`;
 *   2. every rule that fired is covered: a factual sub-query always exists, a
 *      principle one whenever the question needs a lens, and the dalil/sanad
 *      ones for fikih/hadith — either the rule added its own entry, or it
 *      stamped its role onto the role-less entry already carrying its text.
 *      The one coincidence it cannot cover is the model having labelled that
 *      entry with a different declared role: that label is never overwritten,
 *      so the law accepts exactly that case as the exception the header states.
 *      Coverage is asserted for a question that is itself a query — a rule whose
 *      own text carries no letter and no digit has no query to contribute, so
 *      there is nothing to cover (#462);
 *   3. the floor holds on distinct texts: the stage returns a single sub-query
 *      only when that sub-query *is* the question — never a padded
 *      near-duplicate of it (`MIN_SUB_QUERIES`), and never a question that is
 *      not a query at all (#462);
 *   4. no two sub-queries carry the same text (duplicates waste an embed slot
 *      and make the Trace claim angles the model never offered);
 *   5. every kept sub-query has non-empty text and, if labelled, a role from
 *      the vocabulary (a role may repeat: the model's text is kept as it wrote
 *      it — the repair may stamp a fired rule's role onto a role-less entry
 *      carrying that rule's text, but never overwrites a label — and only the
 *      *rules* are deduplicated by role);
 *   6. nothing is returned only when no text the stage was handed — the question
 *      or any reply text — carried a letter or a digit: a blank or content-free
 *      question with a reply that phrased nothing searchable has no retrieval to
 *      run at all (#462);
 *   7. re-running the repair over its own output changes nothing but the
 *      provenance labels (idempotence over text and role) — the law #450 was
 *      filed about — over both the plain and the collision generator below, at a
 *      budget (2 000 runs, ~1 000 per generator) whose verdict is a property of
 *      the repair and not of the seed draw: reverting only the ceiling's
 *      stand-in protection reddens it in 20 of 20 runs (review A1);
 *   8. no text the stage was handed with nothing to search with becomes a
 *      sub-query — blank, whitespace-only, punctuation-only, emoji-only,
 *      `Cf`/`Cc`-only, in ASCII or in any other script — whatever its origin:
 *      not the reply's phrasing, and not a composition rule's own text, which
 *      for `factual` is the caller's question verbatim (#450, #462);
 *   9. and the other direction: a reply text that carries content is kept,
 *      trimmed and as the reply labelled it — the half an ASCII reading of
 *      "content" would narrow away (#450 A2);
 *  10. the ceiling never spends the slot of the entry a fired-but-uncovered
 *      rule's own text lives in — the invariant the module's prose used to
 *      argue rather than check — over both generators at the same budget as
 *      law 7, for a question that is itself a query (#450 B1, #462);
 *  11. every entry is marked as the model's or a rule's.
 */

const subQueryArb: fc.Arbitrary<{ text: string; role?: string }> = fc
  .record(
    {
      text: fc.oneof(
        fc.string({ minLength: 1, maxLength: 40 }),
        // `"hukum riba?"` coincides with a question constant below, so the
        // generator can produce the one class law 2 must reason about: a model
        // entry whose text *is* the rule's own text (review R2-A1).
        fc.constantFrom(
          "hukum riba",
          "hukum riba?",
          "prinsip yusr",
          "dalil Al-Quran",
          "  spaced   text  ",
          // The three non-factual rule templates, whole, for the fixed question
          // the rules are built on: an echo of one of these under another declared
          // role is the coincidence law 2's exception is written for, at every
          // fired role rather than `factual` alone (review A3). They match only
          // when the question, tags and category line up, which is what makes the
          // reach real but rare — the law's own comment says so.
          "prinsip yusr dalam menjawab: hukum riba?",
          "dalil Al-Quran tentang: hukum riba?",
          "sanad dan derajat hadis tentang: hukum riba?",
        ),
        // The content laws' boundary in both directions (#450 A2). `fc.string`
        // above is printable ASCII and every other constant is ASCII too, so
        // without these the generators cannot separate `\p{L}`/`\p{N}` from an
        // ASCII `/[a-z0-9]/i` reading at all — which is how the law's claim to
        // catch that narrowing went unproven.
        fc.constantFrom(...CONTENT_TEXTS, ...CONTENT_FREE_TEXTS),
      ),
      role: fc.option(fc.constantFrom(...SUB_QUERY_ROLES, "tafsir", ""), { nil: undefined }),
    },
    { requiredKeys: ["text"] },
  )
  .map(({ role, ...rest }) => ({ ...rest, ...(role === undefined ? {} : { role }) }));

const inputArb: fc.Arbitrary<DecompositionInput> = fc
  .record(
    {
      question: fc.oneof(
        fc.string({ minLength: 1, maxLength: 60 }),
        fc.constant("hukum riba?"),
        fc.constant("   "),
        // The class the defect lived in (#462): a question carrying no letter
        // and no digit, which the `factual` rule's own text reproduces verbatim.
        // `fc.string` draws printable ASCII and never a zero-width or control
        // body, so without this branch the laws' claim to cover the rule leg's
        // content drop cannot be falsified — the drop is simply never exercised.
        fc.constantFrom(...CONTENT_FREE_QUESTION_TEXTS),
      ),
      needsPrinciple: fc.boolean(),
      principleTags: fc.array(fc.constantFrom(...PRINCIPLE_TAGS), { maxLength: 4 }),
      category: fc.option(fc.constantFrom(...SUBJECT_AREAS), { nil: undefined }),
      modelSubQueries: fc.array(subQueryArb, { maxLength: 8 }),
    },
    { requiredKeys: ["question", "needsPrinciple", "principleTags", "modelSubQueries"] },
  )
  // `exactOptionalPropertyTypes`: an absent category is an absent key, never a
  // present one holding undefined.
  .map(({ category, ...rest }) => ({
    ...rest,
    ...(category === undefined ? {} : { category }),
  }));

/** Text + role only: provenance is the repair's own bookkeeping, not a law. */
const shapeOf = (subs: readonly { text: string; role?: string }[]) =>
  subs.map((sub) => ({ text: sub.text, role: sub.role }));

/** The repair's own duplicate key, restated: what makes two texts "the same text". */
const norm = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The repair's own content test, restated: a letter or a digit in any script is
 * something to search with (#450).
 */
const hasContent = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);

/**
 * The input class that made the idempotence law seed-dependent (#450): a reply
 * that both over-produces and echoes a fired rule's own text under a *different*
 * declared role, so the `factual` rule's coverage rides on an entry the ceiling
 * may spend. The plain generator reaches that class in roughly one case in five
 * thousand — which is why a green run proved nothing and four sightings were read
 * as noise. This one draws it nearly always: five to eight entries (the ceiling
 * fires), the last carrying the question itself under a role drawn from the
 * vocabulary, beside same-role duplicates the ceiling has to choose between.
 */
const collisionArb: fc.Arbitrary<DecompositionInput> = fc
  .record(
    {
      // One non-ASCII question: the entry that carries it is the one law 2's
      // exception and the ceiling both reason about, and its content must
      // survive in either script.
      question: fc.constantFrom("hukum riba?", "q", "حكم الربا"),
      needsPrinciple: fc.boolean(),
      principleTags: fc.array(fc.constantFrom(...PRINCIPLE_TAGS), { maxLength: 2 }),
      category: fc.option(fc.constantFrom(...SUBJECT_AREAS), { nil: undefined }),
      roles: fc.array(fc.constantFrom(...SUB_QUERY_ROLES, "tafsir"), {
        minLength: 5,
        maxLength: 8,
      }),
      texts: fc.array(
        fc.constantFrom(
          "a",
          "b",
          "c",
          "d",
          "e",
          "٥",
          "الربا",
          // A content-free reply text in the collision class too (#462): it must
          // leave the fan-out without disturbing the rule coverage the ceiling
          // is reasoning about, which is what law 10 keeps checking.
          "\u200b\u200d\u200b",
          "prinsip yusr dalam menjawab: hukum riba?",
          "dalil Al-Quran tentang: hukum riba?",
          "sanad dan derajat hadis tentang: hukum riba?",
        ),
        { minLength: 5, maxLength: 8 },
      ),
    },
    { requiredKeys: ["question", "needsPrinciple", "principleTags", "roles", "texts"] },
  )
  .map(({ question, roles, texts, category, ...rest }) => ({
    ...rest,
    question,
    ...(category === undefined ? {} : { category }),
    modelSubQueries: texts.map((text, index) => {
      const role = roles[index];
      return {
        text: index === texts.length - 1 ? question : text,
        ...(role === undefined ? {} : { role }),
      };
    }),
  }));

/** The composition rules that fire for a question, restated from the module (#450). */
const firedRoles = (needsPrinciple: boolean, category: SubjectArea | undefined): SubQueryRole[] => {
  const roles: SubQueryRole[] = ["factual"];
  if (needsPrinciple) roles.push("principle");
  if (category === "fikih") roles.push("dalil");
  if (category === "hadith") roles.push("sanad");
  return roles;
};

/**
 * The module's rule templates, restated (#450): the text a rule adds for a
 * question. Law 2's exception and the stand-in law both key on a rule's *own*
 * text, so deriving it here lets them say "this rule's text, under another
 * declared role" instead of naming one template — which is how the exception
 * stops being written for the `factual` rule alone (review A3).
 */
const ruleTextOf = (
  role: SubQueryRole,
  input: Pick<DecompositionInput, "question" | "principleTags">,
): string => {
  const question = input.question.trim();
  if (role === "principle") {
    const lens = input.principleTags.length > 0 ? input.principleTags.join(", ") : "syariat";
    return `prinsip ${lens} dalam menjawab: ${question}`;
  }
  if (role === "dalil") return `dalil Al-Quran tentang: ${question}`;
  if (role === "sanad") return `sanad dan derajat hadis tentang: ${question}`;
  return question;
};

/**
 * The positive content law's input class (#450 A2): a reply phrasing one or two
 * *different* content-bearing texts, each under a distinct role the rules also
 * fired. Every entry then takes a slot of its own below the ceiling, so the only
 * way a text can leave the fan-out is the content test narrowing — which is what
 * makes the law's expectation exact ("this text, under this role") rather than
 * "present somewhere", and what lets an ASCII `/[a-z0-9]/i` reading redden a law
 * instead of one example. The roles come from the fired set because an entry
 * whose role no rule fired is an extra, and the ceiling may spend it.
 */
const contentReplyArb = (
  fired: readonly SubQueryRole[],
): fc.Arbitrary<{ text: string; role: SubQueryRole }[]> =>
  fc
    .record({
      texts: fc.uniqueArray(fc.constantFrom(...CONTENT_TEXTS), { minLength: 1, maxLength: 2 }),
      roles: fc.uniqueArray(fc.constantFrom(...fired), { minLength: 1, maxLength: 2 }),
    })
    .map(({ texts, roles }) =>
      roles.flatMap((role, index) => {
        const text = texts[index];
        return text === undefined ? [] : [{ text, role }];
      }),
    );

const contentInputArb: fc.Arbitrary<DecompositionInput> = fc
  .record(
    {
      question: fc.constantFrom("hukum riba?", "q", "حكم الربا"),
      needsPrinciple: fc.boolean(),
      principleTags: fc.array(fc.constantFrom(...PRINCIPLE_TAGS), { maxLength: 2 }),
      category: fc.option(fc.constantFrom(...SUBJECT_AREAS), { nil: undefined }),
    },
    { requiredKeys: ["question", "needsPrinciple", "principleTags"] },
  )
  .chain(({ category, ...core }) =>
    contentReplyArb(firedRoles(core.needsPrinciple, category)).map((modelSubQueries) => ({
      ...core,
      ...(category === undefined ? {} : { category }),
      modelSubQueries,
    })),
  );

describe("decomposeQuery laws", () => {
  fcTest.prop([inputArb])("never exceeds the stage's ceiling", (input) => {
    expect(decomposeQuery(input).length).toBeLessThanOrEqual(MAX_SUB_QUERIES);
  });

  // Coverage, the floor and the ceiling's stand-in protection are asserted for a
  // question that is itself a query — one carrying a letter or a digit in some
  // script. A rule whose own text carries none has no query to contribute, and
  // the stage deliberately does not add it (#462), so coverage and the floor
  // have nothing to assert there; law 8 is the one that pins that class, and the
  // blank question is out for the same reason it always was (a blank body has no
  // content in it either).
  const searchableQuestionArb = inputArb.filter((input) => hasContent(input.question));

  fcTest.prop([searchableQuestionArb])(
    "covers every rule that fired, or names its one exception",
    (input) => {
      const subs = decomposeQuery(input);
      const roles = subs.flatMap((sub) => (sub.role === undefined ? [] : [sub.role]));
      // The coverage rule, with the coincidence it cannot close stated as a
      // precondition rather than left as prose, and stated per fired role rather
      // than for `factual` alone (review A3): a rule goes unshown only when the
      // reply itself already labelled the rule's *own text* with a different
      // declared role — the one label the repair never overwrites. The generator
      // reaches the shape (`"hukum riba?"` in `subQueryArb` against the same
      // question constant, and every rule's whole template beside it) and the
      // role-less echo too; without that reach this law would pass over the class
      // it exists to guard (review R2-A1). The `factual`-only guard this replaces
      // went red on a `principle`/`dalil`/`sanad` template echoed under another
      // role — which the module header, `SPECS.md` §3.3 stage 2 and ADR-0051 all
      // document as intended behaviour — and the block below pins those three
      // coincidences directly rather than leaving them to the draw (review A3).
      for (const role of firedRoles(input.needsPrinciple, input.category)) {
        if (roles.includes(role)) continue;
        expect(
          input.modelSubQueries.some(
            (entry) =>
              entry.role !== undefined &&
              entry.role !== role &&
              (SUB_QUERY_ROLES as readonly string[]).includes(entry.role) &&
              norm(entry.text) === norm(ruleTextOf(role, input)),
          ),
        ).toBe(true);
      }
    },
  );

  // Law 2's exception, per fired role, pinned as three examples: the reach the
  // generators can only make rare (review A3). Each case is the documented
  // coincidence — the reply labelled a fired rule's *own text* with another
  // declared role, so that rule's coverage goes unshown while the text it would
  // have added is already what the reply carried. The `factual`-only guard this
  // law replaced reddened on all three.
  it("accepts a non-factual rule's template echoed under another declared role", () => {
    const cases: { input: DecompositionInput; role: SubQueryRole }[] = [
      {
        input: {
          question: "q",
          needsPrinciple: true,
          principleTags: ["yusr"],
          modelSubQueries: [{ text: "prinsip yusr dalam menjawab: q", role: "sanad" }],
        },
        role: "principle",
      },
      {
        input: {
          question: "q",
          needsPrinciple: false,
          principleTags: [],
          category: "fikih",
          modelSubQueries: [{ text: "dalil Al-Quran tentang: q", role: "factual" }],
        },
        role: "dalil",
      },
      {
        input: {
          question: "q",
          needsPrinciple: false,
          principleTags: [],
          category: "hadith",
          modelSubQueries: [{ text: "sanad dan derajat hadis tentang: q", role: "factual" }],
        },
        role: "sanad",
      },
    ];
    for (const { input, role } of cases) {
      const subs = decomposeQuery(input);
      expect(subs.some((sub) => sub.role === role)).toBe(false);
      expect(subs.some((sub) => norm(sub.text) === norm(ruleTextOf(role, input)))).toBe(true);
    }
  });

  fcTest.prop([searchableQuestionArb])(
    "returns one sub-query only when that sub-query is the question",
    (input) => {
      const subs = decomposeQuery(input);
      if (subs.length >= MIN_SUB_QUERIES) return;
      // Contrapositive of the floor: whenever the stage drops below
      // `MIN_SUB_QUERIES` it must have nothing but the caller's own question to
      // search — a model reply that echoed the question, or no usable sub-query
      // at all. Anything else (a model text of its own, or a rule beyond
      // `factual`) reaches the floor by construction; padding to two here would
      // put a synthetic near-duplicate in the Trace.
      expect(subs).toHaveLength(1);
      expect(norm(subs[0]?.text ?? "")).toBe(norm(input.question));
    },
  );

  fcTest.prop([inputArb])("keeps every sub-query's text distinct and non-empty", (input) => {
    const subs = decomposeQuery(input);
    const normalized = subs.map((sub) => sub.text.trim().replace(/\s+/g, " ").toLowerCase());
    expect(normalized.every((text) => text !== "")).toBe(true);
    expect(new Set(normalized).size).toBe(normalized.length);
  });

  fcTest.prop([inputArb])("labels roles only from the vocabulary", (input) => {
    const roles = decomposeQuery(input).flatMap((sub) =>
      sub.role === undefined ? [] : [sub.role],
    );
    expect(roles.every((role) => (SUB_QUERY_ROLES as readonly string[]).includes(role))).toBe(true);
  });

  fcTest.prop([inputArb])(
    "returns nothing only when no text it was handed had anything to search with",
    (input) => {
      // A question that is not a query — blank, punctuation-only, `Cf`/`Cc`-only
      // — with a reply that phrased nothing searchable has no retrieval to run:
      // the empty fan-out is the whole point (#462). Anything else yields at
      // least the `factual` sub-query, so the contrapositive is stated over every
      // text the stage was handed: an empty result means the question carried no
      // letter and no digit AND so did every reply text.
      if (decomposeQuery(input).length > 0) return;
      expect(hasContent(input.question)).toBe(false);
      for (const entry of input.modelSubQueries) expect(hasContent(entry.text)).toBe(false);
    },
  );

  // The headline law, budgeted so that its verdict is a property of the repair
  // and not of the seed draw (#450 A1). At fast-check's default `numRuns: 100`
  // the second generator only bought about two thirds of a verdict: with *only*
  // the ceiling's stand-in protection reverted, the mutant stayed green in 7 of
  // 20 runs (review A1), because it differs from head on ~4 % of `collisionArb`
  // draws. `fc.oneof` splits the budget, so 2 000 runs keep each generator above
  // the 100 draws it had before `fc.oneof` halved them (~1 000 each). Measured at
  // this budget: reverting the stand-in protection reddens this law in 20 of 20
  // runs; the example `keeps the entry a fired rule's coverage lives in when the
  // ceiling spends its budget` and the stand-in law below redden deterministically
  // at any budget, which is what makes the pair robust rather than lucky.
  fcTest.prop([fc.oneof(inputArb, collisionArb)], { numRuns: 2000 })(
    "is idempotent over the sub-queries it produced",
    (input) => {
      const once = decomposeQuery(input);
      const twice = decomposeQuery({
        ...input,
        modelSubQueries: once.map((sub) => ({
          text: sub.text,
          ...(sub.role !== undefined ? { role: sub.role } : {}),
        })),
      });
      expect(shapeOf(twice)).toEqual(shapeOf(once));
    },
  );

  fcTest.prop([inputArb])(
    "keeps no text with nothing to search with, whatever its origin",
    (input) => {
      // The invariant #462 pins, unqualified by origin: a sub-query carries a
      // letter or a digit in any script — `\p{L}`/`\p{N}`, so Arabic, Jawi,
      // Arabic-Indic digits and an ASCII word all count. This law is the
      // *removal* direction (delete the content test and it reddens); the
      // narrowing direction — an ASCII `/[a-z0-9]/i` reading, which this law can
      // only make greener — is the next law's, whose generator draws the
      // non-ASCII texts that tell the two readings apart.
      //
      // The class the exception used to cover is the rule leg's, and it is why
      // the law is stated this way: the `factual` rule's own text *is* the
      // caller's question, and `trim()` strips White_Space only, so a question
      // made of `Cf` (zero-width spaces, joiners, a BOM) or `Cc` (C0 controls)
      // reached the fan-out as `origin: "rule"` and was embedded and searched
      // (#462). The generator draws that class as a *question* — the branch
      // `CONTENT_FREE_QUESTION_TEXTS` adds — so this law is red against the
      // pre-fix source rather than vacuously green.
      for (const sub of decomposeQuery(input)) expect(hasContent(sub.text)).toBe(true);
    },
  );

  // The other half of the content law, and the one an ASCII reading has to
  // redden (#450 A2): a reply text that carries content in any script reaches the
  // fan-out, trimmed and under the role the reply declared. Before this law, the
  // only pin on that direction was a single example in `chat-router-decompose.test.ts`
  // — replacing the content test with `/[a-z0-9]/i` reddened exactly one example
  // and left every law green, so the laws could not see the narrowing the comment
  // above them claimed to catch.
  fcTest.prop([contentInputArb])(
    "keeps a reply text that carries content, trimmed and as the reply labelled it",
    (input) => {
      const subs = decomposeQuery(input);
      for (const entry of input.modelSubQueries) {
        expect(
          subs.some(
            (sub) =>
              sub.text === entry.text.trim() && sub.role === entry.role && sub.origin === "model",
          ),
        ).toBe(true);
      }
    },
  );

  // B1: the ceiling's protection as a checked invariant rather than a proof in
  // the module's prose. When the ceiling fires it must not spend the slot of the
  // entry a fired-but-uncovered rule's own text lives in — that entry is the
  // rule's only evidence, and dropping it makes the next pass re-add the rule's
  // entry at a different position, which is the #450 defect. The argument for
  // `chosen` ≤ `MAX_SUB_QUERIES` is the module's; this is what checks it, over the
  // plain generator and over `collisionArb`, which draws the class (over-production
  // plus a rule's own text under another declared role) on most of its cases.
  // Budgeted like the idempotence law above, and for the same reason: at the
  // default 100 runs this law reddened in only 14 of 20 runs against the pre-fix
  // source; at 2 000 it is red in 20 of 20 (measured).
  fcTest.prop([fc.oneof(searchableQuestionArb, collisionArb)], { numRuns: 2000 })(
    "keeps a fired rule's own text when the rule is left uncovered",
    (input) => {
      const subs = decomposeQuery(input);
      const roles = subs.flatMap((sub) => (sub.role === undefined ? [] : [sub.role]));
      for (const role of firedRoles(input.needsPrinciple, input.category)) {
        if (roles.includes(role)) continue;
        expect(subs.some((sub) => norm(sub.text) === norm(ruleTextOf(role, input)))).toBe(true);
      }
    },
  );

  fcTest.prop([inputArb])("always marks provenance as the model's or a rule's", (input) => {
    const origins = decomposeQuery(input).map((sub) => sub.origin);
    expect(origins.every((origin) => origin === "model" || origin === "rule")).toBe(true);
  });
});
