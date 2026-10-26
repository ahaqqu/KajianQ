/// <reference types="node" />
import { describe, expect, it } from "vite-plus/test";
import type { EvalResultOutcome, GoldenQuestion, GoldenSet } from "@app/contracts";
import {
  addressesNamedBy,
  citationCandidatesIn,
  curatedIdentityResolvers,
  normalizeCitationLabel,
} from "@app/kajianq-domain";
import { buildReport, scoreQuestion } from "./harness";
import type { CitationGrammar, TraceEventLike } from "./harness-types";

/**
 * The identity/equivalence instruments' decisions, fed the packet's own per-row
 * inputs. The cited labels and the retrieval presence are **reported** inputs from
 * the QA audit (the required address retrieved or absent, per row), so nothing here
 * is a run score: each case asserts what the instrument decides on that evidence,
 * which is the property the gate must hold whatever a future run returns. Grade
 * suffixes are omitted from the quoted labels because the gate's own fold strips
 * them; the decision is the same.
 *
 * The trust invariant under test: a cited address is gate-accepted only when it is
 * the requirement's own address (or a curated any-of alternative of it) or a signed
 * **same-report** identity of it. A signed **same-ruling** relation is reported by
 * the identity-satisfied block and never satisfies the gate; exact-address recall
 * stays exact, so the gate's number remains comparable with past runs.
 */

const { gating: gateIdentity, reported: reportedIdentity } = curatedIdentityResolvers();
const GRAMMAR: CitationGrammar = {
  normalizeLabel: normalizeCitationLabel,
  labelsInText: citationCandidatesIn,
  addressesNamedBy,
};

type Retrieved = { label: string; sourceType: string };

const question = (id: string, required: string[], alternatives?: string[]): GoldenQuestion => ({
  id,
  question: id,
  language: "id",
  expectedSourceTypes: ["primary"],
  requiredCitations: required,
  expectedBehavior: "answer",
  ...(alternatives === undefined ? {} : { citationAlternatives: alternatives }),
});

/** One row scored the way the harness scores it: a frame of grounded labels and a
 * retrieval event whose refs resolve to the row's chunk metadata. */
function score(
  row: GoldenQuestion,
  cited: readonly string[],
  retrieved: readonly Retrieved[],
  identity?: {
    gate: typeof gateIdentity | undefined;
    reported?: typeof reportedIdentity | undefined;
  },
): EvalResultOutcome {
  const events: TraceEventLike[] = [
    {
      kind: "retrieval",
      stage: "retriever",
      detail: { chunks: retrieved.map((_, index) => ({ id: `c${index}` })) },
    },
  ];
  return scoreQuestion(
    row,
    "",
    events,
    {
      sourceTypeOf: (id) => retrieved[Number(id.slice(1))]?.sourceType,
      citationOf: (id) => retrieved[Number(id.slice(1))]?.label,
      refusalMarkers: [],
      citationGrammar: GRAMMAR,
      ...(identity?.gate === undefined ? {} : { citationIdentity: identity.gate }),
      ...(identity?.reported === undefined ? {} : { reportedCitationIdentity: identity.reported }),
    },
    { citations: cited.map((label) => ({ label })) },
  );
}

const WITH_BOTH = { gate: gateIdentity, reported: reportedIdentity };

/**
 * The recorded inputs, one entry per failing row of the QA report. The cited set
 * and the required address's presence/absence are the audit's; the neighbouring
 * retrieved labels are the ones it named for the row.
 */
const ROWS = {
  "gs-v0-006": {
    row: question(
      "gs-v0-006",
      ["HR. Bukhari no. 1108"],
      ["HR. Nasai no. 598", "HR. Ibn Majah no. 1070"],
    ),
    cited: ["HR. Malik no. 331", "HR. Ibn Majah no. 1070", "HR. Nasai no. 598"],
    retrieved: [
      { label: "HR. Bukhari no. 1108", sourceType: "primary" },
      { label: "HR. Nasai no. 598", sourceType: "primary" },
      { label: "HR. Malik no. 331", sourceType: "primary" },
      { label: "HR. Ibn Majah no. 1070", sourceType: "primary" },
    ],
  },
  "gs-v0-007": {
    row: question("gs-v0-007", ["QS. 42:11"]),
    cited: ["HR. Tirmidhi no. 662"],
    retrieved: [
      { label: "QS. 59:24", sourceType: "primary" },
      { label: "QS. 2:255", sourceType: "primary" },
      { label: "HR. Tirmidhi no. 662", sourceType: "primary" },
    ],
  },
  "gs-v0-008": {
    row: question(
      "gs-v0-008",
      ["HR. Bukhari no. 5026"],
      ["HR. Bukhari no. 5027", "HR. Bukhari no. 4937"],
    ),
    cited: ["HR. Bukhari no. 5027", "HR. Bukhari no. 4937"],
    retrieved: [
      { label: "HR. Bukhari no. 5027", sourceType: "primary" },
      { label: "HR. Bukhari no. 5028", sourceType: "primary" },
      { label: "HR. Bukhari no. 4937", sourceType: "primary" },
    ],
  },
  "gs-v0-012": {
    row: question("gs-v0-012", ["QS. 1:1"]),
    cited: ["QS. 1:3"],
    retrieved: [
      { label: "QS. 1:1", sourceType: "primary" },
      { label: "QS. 1:3", sourceType: "primary" },
    ],
  },
  "gs-v0-016": {
    row: question("gs-v0-016", ["HR. Bukhari no. 1395"]),
    cited: ["HR. Abu Dawud no. 1584"],
    retrieved: [
      { label: "HR. Abu Dawud no. 1584", sourceType: "primary" },
      { label: "HR. Bukhari no. 1454", sourceType: "primary" },
    ],
  },
  "gs-v0-017": {
    row: question(
      "gs-v0-017",
      ["HR. Nasai no. 5144"],
      [
        "HR. Nasai no. 5148",
        "HR. Nasai no. 5265",
        "HR. Tirmidhi no. 1720",
        "HR. Ibn Majah no. 3597",
      ],
    ),
    cited: ["HR. Nasai no. 5148", "HR. Nasai no. 5149", "HR. Ibn Majah no. 3597"],
    retrieved: [
      { label: "HR. Nasai no. 5144", sourceType: "primary" },
      { label: "HR. Nasai no. 5148", sourceType: "primary" },
      { label: "HR. Nasai no. 5149", sourceType: "primary" },
      { label: "HR. Ibn Majah no. 3597", sourceType: "primary" },
    ],
  },
} as const;

/** The row's requirement without its opt-in alternative set: the shape that
 * isolates what the signed relation decides, since the row's own set is a
 * separate curation decision whose effect is asserted below. */
function withoutOptIn(row: GoldenQuestion): GoldenQuestion {
  const { citationAlternatives: _alternatives, ...requirementOnly } = row;
  return requirementOnly;
}

const outcome = (id: keyof typeof ROWS): EvalResultOutcome => {
  const entry = ROWS[id];
  return score(entry.row, entry.cited, entry.retrieved, WITH_BOTH);
};

describe("D1a — the signed same-report identity of 1395 (016)", () => {
  it("flips citation validity to 1 while the exact address stays 0", () => {
    const scored = outcome("gs-v0-016");
    expect(scored.citationValidity).toBe(1); // Abu Dawud 1584 is the same report
    expect(scored.citationAddressRecall).toBe(0); // 1395 was never retrieved
    expect(scored.passed).toBe(false); // the exact-address gate keeps the residual
  });

  it("is the signed map that moves it: without the map the citation is unvalidated", () => {
    const entry = ROWS["gs-v0-016"];
    expect(score(entry.row, entry.cited, entry.retrieved).citationValidity).toBe(0);
  });

  it("records the residual as reported, never as a gate pass", () => {
    expect(outcome("gs-v0-016").identitySatisfied).toEqual({
      citationAddressRecall: 1,
      citationValidity: 1,
      passed: true,
    });
  });
});

describe("D1b — a signed same-ruling relation never satisfies the exact-address gate", () => {
  it("keeps 006's gate validity at 0 without its opt-in set while the reported measure reads 1", () => {
    const entry = ROWS["gs-v0-006"];
    const scored = score(withoutOptIn(entry.row), entry.cited, entry.retrieved, WITH_BOTH);
    expect(scored.citationValidity).toBe(0); // 598 is the same ruling, not the same report
    expect(scored.citationAddressRecall).toBe(1); // the required address was retrieved
    expect(scored.passed).toBe(false);
    expect(scored.identitySatisfied?.citationValidity).toBe(1);
    expect(scored.identitySatisfied?.passed).toBe(true);
  });

  it("keeps 017's gate validity at 0 without its opt-in set while the reported measure reads 1", () => {
    const entry = ROWS["gs-v0-017"];
    const scored = score(withoutOptIn(entry.row), entry.cited, entry.retrieved, WITH_BOTH);
    expect(scored.citationValidity).toBe(0);
    expect(scored.citationAddressRecall).toBe(1);
    expect(scored.passed).toBe(false);
    expect(scored.identitySatisfied?.citationValidity).toBe(1);
    expect(scored.identitySatisfied?.passed).toBe(true);
  });

  it("does not leak the broader resolver into the gate when only that resolver is injected", () => {
    // The gate's resolver comes from `citationIdentity`, never from the reported
    // one; a scoreQuestion that read the broader resolver for both would accept
    // 598 here and fail this trap.
    const entry = ROWS["gs-v0-006"];
    const scored = score(withoutOptIn(entry.row), entry.cited, entry.retrieved, {
      gate: undefined,
      reported: reportedIdentity,
    });
    expect(scored.citationValidity).toBe(0);
    expect(scored.identitySatisfied?.citationValidity).toBe(1);
  });

  it("keeps the exact-address recall mean unmoved by the reported relation", () => {
    // `citationAddressRecall` is the gate's number and has no identity parameter;
    // the identity-satisfied figure lives in its own block. Two different names,
    // two different meanings — the comparability rule.
    const scored = outcome("gs-v0-016");
    expect(scored.citationAddressRecall).toBe(0);
    expect(scored.identitySatisfied?.citationAddressRecall).toBe(1);
  });
});

describe("D3b — the curated alternative sets are the opt-in that widens 006 and 017", () => {
  it("passes 006 through its own set, not through the same-ruling relation", () => {
    const scored = outcome("gs-v0-006");
    expect(scored.citationValidity).toBe(1); // 598 and 1070 are curator-accepted answers
    expect(scored.citationAddressRecall).toBe(1); // the required address was retrieved
    expect(scored.passed).toBe(true);
  });

  it("passes 017 through its own set and accepts each member alone", () => {
    const entry = ROWS["gs-v0-017"];
    const scored = outcome("gs-v0-017");
    expect(scored.citationValidity).toBe(1);
    expect(scored.citationAddressRecall).toBe(1);
    expect(scored.passed).toBe(true);
    for (const alternative of entry.row.citationAlternatives ?? []) {
      const alone = score(entry.row, [alternative], entry.retrieved, WITH_BOTH);
      expect(alone.citationValidity, alternative).toBe(1);
    }
  });

  it("does not accept a member the curator excluded", () => {
    // 5149 states the exception ("except a cut piece"), a different ruling, and
    // 1454 is the zakat schedule, not the obligation/recipient ruling.
    const exception = score(
      ROWS["gs-v0-017"].row,
      ["HR. Nasai no. 5149"],
      ROWS["gs-v0-017"].retrieved,
      WITH_BOTH,
    );
    expect(exception.citationValidity).toBe(0);
    expect(exception.identitySatisfied?.citationValidity).toBe(0);
    const schedule = score(
      ROWS["gs-v0-016"].row,
      ["HR. Bukhari no. 1454"],
      ROWS["gs-v0-016"].retrieved,
      WITH_BOTH,
    );
    expect(schedule.citationValidity).toBe(0);
    expect(schedule.identitySatisfied?.citationValidity).toBe(0);
  });
});

describe("D2 — the curated verse pair {QS. 1:1, QS. 1:3}", () => {
  it("flips 012 only through the signed pair", () => {
    const scored = outcome("gs-v0-012");
    expect(scored.citationValidity).toBe(1); // 1:3 is the pair of names, 1:1 adds the basmalah
    expect(scored.citationAddressRecall).toBe(1); // the required address 1:1 was retrieved
    expect(scored.passed).toBe(true);
    const entry = ROWS["gs-v0-012"];
    expect(score(entry.row, entry.cited, entry.retrieved).citationValidity).toBe(0);
  });

  it("does not generalize to a verse that merely shares both names", () => {
    const entry = ROWS["gs-v0-012"];
    const scored = score(entry.row, ["QS. 55:1"], entry.retrieved, WITH_BOTH);
    expect(scored.citationValidity).toBe(0);
    expect(scored.identitySatisfied?.citationValidity).toBe(0);
  });
});

describe("D3 — 008's opt-in any-of requirement is a set, not a loosened substring", () => {
  it("passes both dimensions through the curated alternative", () => {
    const scored = outcome("gs-v0-008");
    expect(scored.citationValidity).toBe(1); // 5027 is a curator-accepted answer to the question
    expect(scored.citationAddressRecall).toBe(1); // and it was retrieved
    expect(scored.passed).toBe(true);
  });

  it("stays failed without the opt-in set: the default requirement is the exact 5026", () => {
    const entry = ROWS["gs-v0-008"];
    const withoutSet = question("gs-v0-008", ["HR. Bukhari no. 5026"]);
    const scored = score(withoutSet, entry.cited, entry.retrieved, WITH_BOTH);
    expect(scored.citationValidity).toBe(0);
    expect(scored.citationAddressRecall).toBe(0);
    expect(scored.passed).toBe(false);
  });
});

describe("D4 — identity-satisfied address recall is reported beside the exact gate", () => {
  it("reads 016 as reached by identity where the exact address is 0", () => {
    const scored = outcome("gs-v0-016");
    expect(scored.citationAddressRecall).toBe(0);
    expect(scored.identitySatisfied?.citationAddressRecall).toBe(1);
  });

  it("reads 007 as reached by neither instrument", () => {
    const scored = outcome("gs-v0-007");
    expect(scored.citationAddressRecall).toBe(0);
    expect(scored.citationValidity).toBe(0);
    expect(scored.identitySatisfied).toEqual({
      citationAddressRecall: 0,
      citationValidity: 0,
      passed: false,
    });
  });
});

describe("the gate's AND default is unchanged", () => {
  it("requires every required citation, not any one of them", () => {
    const row = question("gs-v0-and", ["HR. Bukhari no. 1", "HR. Muslim no. 2"]);
    const scored = score(
      row,
      ["HR. Bukhari no. 1"],
      [
        { label: "HR. Bukhari no. 1", sourceType: "primary" },
        { label: "HR. Muslim no. 2", sourceType: "primary" },
      ],
      WITH_BOTH,
    );
    expect(scored.citationValidity).toBe(0.5);
    expect(scored.citationAddressRecall).toBe(1); // both addresses were retrieved
    expect(scored.passed).toBe(false);
  });
});

describe("the projection the PR states is derived from these decisions", () => {
  it("moves 006, 008, 012 and 017 on the gate, and reaches 016 only as reported", () => {
    const ids = Object.keys(ROWS) as (keyof typeof ROWS)[];
    const gatePassing = ids.filter((id) => outcome(id).passed);
    expect(gatePassing).toEqual(["gs-v0-006", "gs-v0-008", "gs-v0-012", "gs-v0-017"]);
    const reportedPassing = ids.filter((id) => outcome(id).identitySatisfied?.passed === true);
    expect(reportedPassing).toEqual([
      "gs-v0-006",
      "gs-v0-008",
      "gs-v0-012",
      "gs-v0-016",
      "gs-v0-017",
    ]);
    // 007 is the only row neither instrument reaches; it needs the concept lever.
    expect(outcome("gs-v0-007").identitySatisfied?.passed).toBe(false);
    // 008 and 012 move on a signed identity and a curated verse pair; 006 and 017
    // move on their own alternative sets; 016 stays red on the exact address this
    // recorded evidence never retrieved, and the reported figure shows it.
    expect(gatePassing.length).toBe(4);
    expect(reportedPassing.length).toBe(5);
  });
});

describe("the run report carries the reported figure beside the gate's", () => {
  const SET: GoldenSet = {
    id: "set",
    status: "v0-draft",
    questions: [question("a", ["HR. Bukhari no. 1"])],
  };
  const row = (id: string, passed: boolean, identityPassed: boolean): EvalResultOutcome => ({
    questionId: id,
    expectedBehavior: "answer",
    passed,
    sourceTypeRecall: 1,
    citationValidity: passed ? 1 : 0,
    citationAddressRecall: passed ? 1 : 0,
    refused: false,
    identitySatisfied: {
      citationAddressRecall: 1,
      citationValidity: 1,
      passed: identityPassed,
    },
  });

  it("counts identity-satisfied passes without changing the gate's passed count", () => {
    const results = [row("a", true, true), row("b", false, true)];
    const report = buildReport(SET, {
      runId: "run",
      startedAt: 0,
      finishedAt: 1,
      results,
      passed: 1,
      failed: 1,
      skipped: 0,
      budgetExceeded: false,
      scored: results,
      costMicroUsd: 0,
      costs: [],
    });
    expect(report.passed).toBe(1);
    expect(report.identitySatisfiedPassed).toBe(2);
    expect(report.meanIdentitySatisfiedCitationAddressRecall).toBe(1);
  });

  it("omits the reported fields when no row carried the block", () => {
    const results: EvalResultOutcome[] = [
      {
        questionId: "a",
        expectedBehavior: "answer",
        passed: true,
        sourceTypeRecall: 1,
        citationValidity: 1,
        refused: false,
      },
    ];
    const report = buildReport(SET, {
      runId: "run",
      startedAt: 0,
      finishedAt: 1,
      results,
      passed: 1,
      failed: 0,
      skipped: 0,
      budgetExceeded: false,
      scored: results,
      costMicroUsd: 0,
      costs: [],
    });
    expect(report.identitySatisfiedPassed).toBeUndefined();
    expect(report.meanIdentitySatisfiedCitationAddressRecall).toBeUndefined();
  });
});
