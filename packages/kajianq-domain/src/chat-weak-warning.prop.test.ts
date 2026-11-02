import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import type { AssembledContext, Chunk } from "@app/rag-core";
import {
  applyProductRules,
  dhaifChainWarning,
  dhaifWarning,
  hasWeakWarning,
} from "./chat-postprocess";
import { citedWeakGradeScope, type WeakGradeScope } from "./chat-weak-warning";
import { validateCitations } from "./chat-citation-validator";
import type { KajianQFilters } from "./filters";
import { routedQuery } from "./test-utils/routed-query";

/**
 * The invariant, machine-checked: **the deterministic weak-evidence warning
 * describes the hadith the delivered answer cites, and nothing else.**
 *
 * For an arbitrary retrieved set and an arbitrary subset of it that the draft
 * cites, the warning fires exactly when a CITED passage is weak — graded dhaif
 * as a whole, or carrying a weak transmission row — and it fires at that
 * passage's scope. A weak passage the draft never cites contributes nothing:
 * that is the false-positive shape a per-retrieved-chunk trigger produced, and
 * the property is stated over the whole subset lattice rather than over the one
 * fixture a regression test can carry.
 *
 * It also ties the delivered text to the trace's `applied` list, so an operator
 * reading `product_rules` is never told the rule fired on an answer that does
 * not carry the copy — or spared the record of one that does.
 *
 * Every generated draft starts without the product's copy, so `applied` records
 * the append in exactly the runs that carry the warning; the draft that already
 * carries a copy records `[]` by design (ADR-0007), and that case is pinned in
 * `chat-postprocess.test.ts`, not here.
 */

const context = (chunks: readonly Chunk[]): AssembledContext<KajianQFilters> => ({
  query: routedQuery("q"),
  chunks,
  turns: [{ role: "user", content: "evidence" }],
});

/** The transmission row that makes a passage's evidence weak without its grade. */
const WEAK_ROW = {
  chains: [{ narratorIds: ["n1"], grade: "dhaif", grader: "al-daraqutni" }],
  narrators: [],
  moreMayExist: false,
};

/**
 * A label per passage whose **number is a prefix of the next passage's number**
 * (`… no. 1`, `… no. 11`, `… no. 111`, …). The nested fixture is deliberate: the
 * gate's grounded pass is a containment read, so a label that only *prefixes* a
 * cited one is the counterexample its address boundary must exclude, and a
 * padded or single-width label set would assume that boundary instead of
 * generating across it.
 */
const label = (index: number): string => `HR. Test no. ${"1".repeat(index + 1)}`;

/** A citation no generated chunk grounds — no label is its prefix or its suffix. */
const UNGROUNDED_LABEL = "HR. Test no. 999";

type PassageSpec = {
  /** The passage's own flattened grade; `null` = no grade stored. */
  grade: "dhaif" | "sahih" | null;
  /** Whether a weak row rides the passage's transmission evidence. */
  weakChain: boolean;
  /** Whether the draft names this passage's label. */
  cited: boolean;
};

const passageSpec = fc.record({
  grade: fc.constantFrom<PassageSpec["grade"]>("dhaif", "sahih", null),
  weakChain: fc.boolean(),
  cited: fc.boolean(),
});

const scenario = fc.record({
  passages: fc.array(passageSpec, { maxLength: 6 }),
  /** An extra citation the retrieved set does not ground (refused before rules run). */
  ungroundedCitation: fc.boolean(),
  language: fc.constantFrom<"id" | "en">("id", "en"),
});

type Scenario = {
  passages: readonly PassageSpec[];
  ungroundedCitation: boolean;
  language: "id" | "en";
};

function chunkFor(passage: PassageSpec, index: number): Chunk {
  return {
    id: `c-${String(index)}`,
    text: "evidence",
    metadata: {
      citation: label(index),
      sourceType: "hadith",
      ...(passage.grade !== null ? { grade: passage.grade } : {}),
      ...(passage.weakChain ? { isnad: WEAK_ROW } : {}),
    },
  };
}

function draftFor(input: Scenario): string {
  const citations = input.passages.flatMap((passage, index) =>
    passage.cited ? [`[${label(index)}]`] : [],
  );
  if (input.ungroundedCitation) citations.push(`[${UNGROUNDED_LABEL}]`);
  return citations.length === 0
    ? "Jawaban tanpa sitasi."
    : `Jawaban memakai ${citations.join(" ")}.`;
}

/** The warning scope the cited passages demand, independently of the rule. */
function expectedScope(passages: readonly PassageSpec[]): WeakGradeScope | null {
  const cited = passages.filter((passage) => passage.cited);
  if (cited.some((passage) => passage.grade === "dhaif")) return "passage";
  return cited.some((passage) => passage.weakChain) ? "chain" : null;
}

describe("the weak-evidence trigger over the cited subset, not the retrieved set", () => {
  it("fires exactly on the cited weakness, at its scope, through the delivered text and the trace", () => {
    const property = fc.property(scenario, (input) => {
      const chunks = input.passages.map(chunkFor);
      const draftText = draftFor(input);
      const expected = expectedScope(input.passages);
      // The production seam: the reviewer stage passes the gate's grounded set
      // into the rule. Both forms must agree — the passed set and the trigger's
      // own derivation — or the rule could read a different citation set than the
      // trace records.
      const grounded = validateCitations(draftText, chunks).grounded;

      expect(citedWeakGradeScope(draftText, chunks, grounded), draftText).toBe(expected);
      expect(citedWeakGradeScope(draftText, chunks), draftText).toBe(expected);

      const { draft, applied } = applyProductRules(
        { text: draftText },
        context(chunks),
        input.language,
        grounded,
      );
      const warns = expected !== null;
      expect(hasWeakWarning(draft.text), draftText).toBe(warns);
      expect(applied.includes("dhaif_warning"), draftText).toBe(warns);

      const passageCopy = dhaifWarning(input.language);
      const chainCopy = dhaifChainWarning(input.language);
      if (expected === "passage") {
        expect(draft.text, draftText).toContain(passageCopy);
        expect(draft.text, draftText).not.toContain(chainCopy);
      } else if (expected === "chain") {
        expect(draft.text, draftText).toContain(chainCopy);
        expect(draft.text, draftText).not.toContain(passageCopy);
      } else {
        expect(draft.text, draftText).not.toContain(passageCopy);
        expect(draft.text, draftText).not.toContain(chainCopy);
      }
      // One card, never a duplicate beside it.
      expect(draft.text.split(passageCopy).length - 1, draftText).toBe(
        expected === "passage" ? 1 : 0,
      );
      expect(draft.text.split(chainCopy).length - 1, draftText).toBe(expected === "chain" ? 1 : 0);
    });

    expect(fc.assert(property, { numRuns: 300 })).toBeUndefined();
  });
});
