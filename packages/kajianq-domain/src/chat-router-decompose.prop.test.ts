import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import {
  decomposeQuery,
  MAX_SUB_QUERIES,
  MIN_SUB_QUERIES,
  type DecompositionInput,
} from "./chat-router-decompose";
import { PRINCIPLE_TAGS, SUBJECT_AREAS, SUB_QUERY_ROLES } from "./taxonomy";

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
 *      ones for fikih/hadith;
 *   3. the floor holds on distinct texts: the stage returns a single sub-query
 *      only when that sub-query *is* the question — never a padded
 *      near-duplicate of it (`MIN_SUB_QUERIES`);
 *   4. no two sub-queries carry the same text (duplicates waste an embed slot
 *      and make the Trace claim angles the model never offered);
 *   5. every kept sub-query has non-empty text and, if labelled, a role from
 *      the vocabulary (a role may repeat: the model's own entries are kept as
 *      it wrote them, and only the *rules* are deduplicated by role);
 *   6. nothing is returned only when there was nothing to search;
 *   7. re-running the repair over its own output changes nothing but the
 *      provenance labels (idempotence over text and role);
 *   8. every entry is marked as the model's or a rule's.
 */

const subQueryArb: fc.Arbitrary<{ text: string; role?: string }> = fc
  .record(
    {
      text: fc.oneof(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.constantFrom("hukum riba", "prinsip yusr", "dalil Al-Quran", "  spaced   text  "),
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

describe("decomposeQuery laws", () => {
  fcTest.prop([inputArb])("never exceeds the stage's ceiling", (input) => {
    expect(decomposeQuery(input).length).toBeLessThanOrEqual(MAX_SUB_QUERIES);
  });

  // The caller's question is validated at the HTTP boundary (1..N characters)
  // but a whitespace-only body is accepted there, so coverage is asserted for
  // a question that actually carries text — the blank case is its own law below.
  const answerableArb = inputArb.filter((input) => input.question.trim() !== "");

  fcTest.prop([answerableArb])("covers every rule that fired", (input) => {
    const roles = decomposeQuery(input).flatMap((sub) =>
      sub.role === undefined ? [] : [sub.role],
    );
    expect(roles).toContain("factual");
    if (input.needsPrinciple) expect(roles).toContain("principle");
    if (input.category === "fikih") expect(roles).toContain("dalil");
    if (input.category === "hadith") expect(roles).toContain("sanad");
  });

  fcTest.prop([answerableArb])(
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

  fcTest.prop([inputArb])("returns nothing only when there was nothing to search", (input) => {
    // A blank question with a reply that carried no usable sub-query has no
    // retrieval to run; anything else yields at least the factual sub-query.
    if (decomposeQuery(input).length === 0) expect(input.question.trim()).toBe("");
  });

  fcTest.prop([inputArb])("is idempotent over the sub-queries it produced", (input) => {
    const once = decomposeQuery(input);
    const twice = decomposeQuery({
      ...input,
      modelSubQueries: once.map((sub) => ({
        text: sub.text,
        ...(sub.role !== undefined ? { role: sub.role } : {}),
      })),
    });
    expect(shapeOf(twice)).toEqual(shapeOf(once));
  });

  fcTest.prop([inputArb])("always marks provenance as the model's or a rule's", (input) => {
    const origins = decomposeQuery(input).map((sub) => sub.origin);
    expect(origins.every((origin) => origin === "model" || origin === "rule")).toBe(true);
  });
});
