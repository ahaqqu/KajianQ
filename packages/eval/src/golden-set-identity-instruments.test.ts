/// <reference types="node" />
import { readFileSync } from "node:fs";
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
 * The trust invariant under test: a cited address is gate-accepted when it is the
 * requirement's own address, a curated any-of alternative of it, or a signed
 * identity of it under either relation the map records. A same-report group is a
 * parallel chain; a same-ruling group is another report of the same ruling, and
 * both satisfy citation validity. Exact-address recall stays exact and has no
 * identity parameter; only the reported identity-satisfied block widens its
 * address comparison, so the gate's number remains comparable with past runs.
 */

const {
  gating: gateIdentity,
  reported: reportedIdentity,
  groups: IDENTITY_GROUPS,
} = curatedIdentityResolvers();
const GRAMMAR: CitationGrammar = {
  normalizeLabel: normalizeCitationLabel,
  labelsInText: citationCandidatesIn,
  addressesNamedBy,
};

/** The head fixture's rows, keyed by id. 006's requirement and opt-in set and
 * 022's are head curation, not recorded run inputs, so both are read from the
 * fixture the harness applies — one parse pays for the requirement beside the
 * set, and neither half can drift from the row. `expectedSourceTypes` stays each
 * case's own scoring input (`question()` below), not the fixture's own value: the
 * retrieved labels in these cases are `primary`, and the cases assert the
 * citation decisions, not source-type recall. */
const HEAD_QUESTIONS = (
  JSON.parse(
    readFileSync(
      new URL("../../../packages/kajianq-domain/fixtures/golden-set-v0.json", import.meta.url),
      "utf8",
    ),
  ) as { questions: (GoldenQuestion & { $comment?: string })[] }
).questions;

function headRow(id: string): GoldenQuestion {
  const row = HEAD_QUESTIONS.find((entry) => entry.id === id);
  if (row === undefined) throw new Error(`the fixture has no row ${id}`);
  return row;
}

const HEAD_006 = headRow("gs-v0-006");
const HEAD_008 = headRow("gs-v0-008");
const HEAD_017 = headRow("gs-v0-017");
const HEAD_022 = headRow("gs-v0-022");

/** The row's single required address; a row with none cannot anchor a group. */
function requiredAddress(row: GoldenQuestion): string {
  const [address] = row.requiredCitations;
  if (address === undefined) throw new Error(`the fixture row ${row.id} has no required citation`);
  return address;
}

/** The group the requirement anchors, by relation. A changed requirement stops
 * resolving here, so the fixture/map drift is a red case rather than a silent
 * re-read of another group. */
function identityGroup(
  relation: "same-report" | "same-ruling",
  canonical: string,
): (typeof IDENTITY_GROUPS)[number] | undefined {
  const normalized = normalizeCitationLabel(canonical);
  return IDENTITY_GROUPS.find(
    (group) =>
      group.relation === relation && normalizeCitationLabel(group.canonical) === normalized,
  );
}

type Retrieved = { label: string; sourceType: string };

/** One row scored the way the harness scores it. `expectedSourceTypes` is the
 * case's own scoring input, not a fixture field: the retrieved labels below are
 * `primary`, so this helper's rows are scored as primary-source answers. */
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

/** 022's curated disposition, not a recorded cited set: the retrieved frame
 * carries the required address and every curated sibling, so each member below
 * can be grounded alone. */
const GS_022 = {
  row: question("gs-v0-022", HEAD_022.requiredCitations, HEAD_022.citationAlternatives),
  retrieved: [
    { label: "HR. Bukhari no. 5971", sourceType: "primary" },
    { label: "HR. Abu Dawud no. 5139", sourceType: "primary" },
    { label: "HR. Tirmidhi no. 1897", sourceType: "primary" },
    { label: "HR. Ibn Majah no. 3661", sourceType: "primary" },
    { label: "HR. Muslim no. 6500", sourceType: "primary" },
    { label: "HR. Muslim no. 6501", sourceType: "primary" },
    { label: "HR. Muslim no. 6502", sourceType: "primary" },
    { label: "HR. Muslim no. 6503", sourceType: "primary" },
    { label: "HR. Ibn Majah no. 2706", sourceType: "primary" },
    { label: "HR. Ibn Majah no. 3658", sourceType: "primary" },
  ] as Retrieved[],
};

/** The same frame plus each report the fixture records as excluded, so the
 * rejection is decided on retrieved evidence rather than on absence. */
const GS_022_EXCLUDED_FRAME: Retrieved[] = [
  ...GS_022.retrieved,
  ...(HEAD_022.excludedCitations ?? []).map((label) => ({ label, sourceType: "primary" })),
];

/**
 * The recorded inputs, one entry per failing row of the QA report. The cited set
 * and the required address's presence/absence are the audit's; the neighbouring
 * retrieved labels are the ones it named for the row.
 */
const ROWS = {
  "gs-v0-006": {
    row: question("gs-v0-006", HEAD_006.requiredCitations, HEAD_006.citationAlternatives),
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
    row: question("gs-v0-017", ["HR. Nasai no. 5144"], HEAD_017.citationAlternatives),
    cited: ["HR. Nasai no. 5148", "HR. Nasai no. 5149", "HR. Ibn Majah no. 3597"],
    retrieved: [
      { label: "HR. Nasai no. 5144", sourceType: "primary" },
      { label: "HR. Nasai no. 5148", sourceType: "primary" },
      { label: "HR. Nasai no. 5149", sourceType: "primary" },
      { label: "HR. Ibn Majah no. 3597", sourceType: "primary" },
    ],
  },
} as const;

/** 008's retrieved frame, widened with the reports the row read and ruled out. */
const GS_008_EXCLUDED_FRAME: Retrieved[] = [
  ...ROWS["gs-v0-008"].retrieved,
  ...(HEAD_008.excludedCitations ?? []).map((label) => ({ label, sourceType: "primary" })),
];

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

describe("D1b — the signed same-ruling relation satisfies the gate", () => {
  it("accepts 006 without its opt-in set through the map, and the row passes", () => {
    const entry = ROWS["gs-v0-006"];
    const scored = score(withoutOptIn(entry.row), entry.cited, entry.retrieved, WITH_BOTH);
    expect(scored.citationValidity).toBe(1); // 598 and 1070 state the same ruling
    expect(scored.citationAddressRecall).toBe(1); // the required address was retrieved
    expect(scored.passed).toBe(true);
    expect(scored.identitySatisfied?.citationValidity).toBe(1);
    expect(scored.identitySatisfied?.passed).toBe(true);
  });

  it("accepts 017 without its opt-in set through the map, and the row passes", () => {
    const entry = ROWS["gs-v0-017"];
    const scored = score(withoutOptIn(entry.row), entry.cited, entry.retrieved, WITH_BOTH);
    expect(scored.citationValidity).toBe(1); // 5148 and 3597 state the same ruling
    expect(scored.citationAddressRecall).toBe(1);
    expect(scored.passed).toBe(true);
    expect(scored.identitySatisfied?.citationValidity).toBe(1);
    expect(scored.identitySatisfied?.passed).toBe(true);
  });

  it("does not read the reported resolver in the gate's place", () => {
    // `citationIdentity` is the gate's injection; `reportedCitationIdentity` only
    // feeds the reported block. A scoreQuestion that read the reported resolver
    // for both would accept 598 without the gate's map and fail this trap.
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

describe("D1c — an opt-in alternative is a label, not an identity entry point", () => {
  // 5144 is a gold-and-silk narration, foreign to 5026's recitation-merit
  // component: only its own label may satisfy the row, never its same-ruling
  // sibling 5145.
  const row = question(
    "gs-v0-foreign-alternative",
    ["HR. Bukhari no. 5026"],
    ["HR. Nasai no. 5144"],
  );

  it("passes on the alternative's own normalized label", () => {
    const label = "HR. Nasai no. 5144";
    const scored = score(row, [label], [{ label, sourceType: "primary" }], WITH_BOTH);
    expect(scored.citationValidity).toBe(1);
    expect(scored.identitySatisfied?.citationValidity).toBe(1);
  });

  it("fails on a same-ruling sibling of a foreign alternative", () => {
    const sibling = "HR. Nasai no. 5145";
    expect(gateIdentity.identityOf(sibling)).toBe(gateIdentity.identityOf("HR. Nasai no. 5144"));
    expect(gateIdentity.identityOf(sibling)).not.toBe(
      gateIdentity.identityOf("HR. Bukhari no. 5026"),
    );
    const scored = score(row, [sibling], [{ label: sibling, sourceType: "primary" }], WITH_BOTH);
    expect(scored.citationValidity).toBe(0);
    expect(scored.identitySatisfied?.citationValidity).toBe(0);
  });
});

describe("D3b — the curated alternative sets are the opt-in that widens 006 and 017", () => {
  it("pins the fixture set to 006's map group, so either side's edit flows through", () => {
    const group = identityGroup("same-ruling", requiredAddress(HEAD_006));
    expect(group, "006's requirement anchors a same-ruling map group").toBeDefined();
    if (group === undefined) return;
    // The per-member loop below reads the fixture, so a member added there is
    // covered without a hand edit; adding it to the map instead reds this pin
    // until the fixture accepts it.
    expect(new Set(HEAD_006.citationAlternatives)).toEqual(new Set(group.members));
  });

  it("passes 006 through its own set and accepts each member alone", () => {
    const entry = ROWS["gs-v0-006"];
    const alternatives = entry.row.citationAlternatives ?? [];
    expect(alternatives.length).toBeGreaterThan(0);
    const scored = outcome("gs-v0-006");
    expect(scored.citationValidity).toBe(1); // every member is a curator-accepted answer
    expect(scored.citationAddressRecall).toBe(1); // the required address was retrieved
    expect(scored.passed).toBe(true);
    for (const alternative of alternatives) {
      const alone = score(entry.row, [alternative], entry.retrieved, WITH_BOTH);
      expect(alone.citationValidity, alternative).toBe(1);
      expect(alone.passed, alternative).toBe(true);
    }
  });

  it("accepts each map same-ruling member alone, with or without the set", () => {
    const entry = ROWS["gs-v0-006"];
    // The list is the fixture's own set, so a member added to the curation is
    // disposed of here without a hand edit.
    const alternatives = HEAD_006.citationAlternatives ?? [];
    expect(alternatives.length).toBeGreaterThan(0);
    for (const member of alternatives) {
      const alone = score(entry.row, [member], entry.retrieved, WITH_BOTH);
      expect(alone.citationValidity, member).toBe(1);
      expect(alone.passed, member).toBe(true);
      // The row's opt-in set widens the exact-address leg, not the validity
      // decision: the map's signed same-ruling relation validates the member
      // with the set removed too — including 1070, the Mu'adh report.
      const withoutSet = score(withoutOptIn(entry.row), [member], entry.retrieved, WITH_BOTH);
      expect(withoutSet.citationValidity, member).toBe(1);
      expect(withoutSet.identitySatisfied?.citationValidity, member).toBe(1);
      expect(withoutSet.passed, member).toBe(true);
    }
  });

  it("passes 017 through its own set and accepts each member alone", () => {
    const entry = ROWS["gs-v0-017"];
    const alternatives = entry.row.citationAlternatives ?? [];
    expect(alternatives.length).toBeGreaterThan(0);
    const scored = outcome("gs-v0-017");
    expect(scored.citationValidity).toBe(1);
    expect(scored.citationAddressRecall).toBe(1);
    expect(scored.passed).toBe(true);
    for (const alternative of alternatives) {
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
    // 006's excluded neighbours, even with its widened set in place: 331 is a
    // Successor's fatwa, 1069 is Daif by every grader, 1194 is qasr, 602
    // combines while resident, 1668 and 888 are Muzdalifah/Hajj material, and
    // 1111, 1112 and 326 combine Dhuhr and Asr only.
    for (const label of [
      "HR. Malik no. 331",
      "HR. Ibn Majah no. 1069",
      "HR. Ibn Majah no. 1194",
      "HR. Nasai no. 602",
      "HR. Bukhari no. 1668",
      "HR. Tirmidhi no. 888",
      "HR. Bukhari no. 1111",
      "HR. Bukhari no. 1112",
      "HR. Malik no. 326",
    ]) {
      const excluded = score(
        ROWS["gs-v0-006"].row,
        [label],
        ROWS["gs-v0-006"].retrieved,
        WITH_BOTH,
      );
      expect(excluded.citationValidity, label).toBe(0);
      expect(excluded.identitySatisfied?.citationValidity, label).toBe(0);
    }
  });
});

describe("D3c — 022's same-ruling siblings are the opt-in that widens it", () => {
  it("pins the fixture's set and the map's groups, so either side's edit flows through", () => {
    const report = identityGroup("same-report", requiredAddress(HEAD_022));
    const ruling = identityGroup("same-ruling", requiredAddress(HEAD_022));
    expect(report, "022's requirement anchors a same-report map group").toBeDefined();
    expect(ruling, "022's requirement anchors a same-ruling map group").toBeDefined();
    if (report === undefined || ruling === undefined) return;
    // The opt-in set is the fixture's and the chains below are the map's. A
    // member added to either curation is covered without a hand edit, and a
    // requirement changed away from the anchor stops resolving here.
    expect(new Set(HEAD_022.citationAlternatives ?? [])).toEqual(new Set(ruling.members));
    expect(report.members.length).toBeGreaterThan(0);
  });

  it("passes through its own set and accepts each same-ruling member alone", () => {
    const alternatives = GS_022.row.citationAlternatives ?? [];
    expect(alternatives.length).toBeGreaterThan(0);
    const scored = score(GS_022.row, ["HR. Abu Dawud no. 5139"], GS_022.retrieved, WITH_BOTH);
    expect(scored.citationValidity).toBe(1);
    expect(scored.citationAddressRecall).toBe(1);
    expect(scored.passed).toBe(true);
    for (const member of alternatives) {
      const alone = score(GS_022.row, [member], GS_022.retrieved, WITH_BOTH);
      expect(alone.citationValidity, member).toBe(1);
      expect(alone.citationAddressRecall, member).toBe(1);
      expect(alone.passed, member).toBe(true);
    }
  });

  it("accepts each same-ruling member without the set through the map", () => {
    for (const member of GS_022.row.citationAlternatives ?? []) {
      const withoutSet = score(withoutOptIn(GS_022.row), [member], GS_022.retrieved, WITH_BOTH);
      expect(withoutSet.citationValidity, member).toBe(1);
      expect(withoutSet.identitySatisfied?.citationValidity, member).toBe(1);
      expect(withoutSet.passed, member).toBe(true);
    }
  });

  it("accepts the report's own parallel chains as the signed same-report identity", () => {
    const chains = identityGroup("same-report", requiredAddress(HEAD_022))?.members ?? [];
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      // These are chains of 5971's own Abu Hurayra report, so the map's
      // same-report relation satisfies the gate without the opt-in set; the
      // required address is present in the frame, so the row passes.
      const withoutSet = score(withoutOptIn(GS_022.row), [chain], GS_022.retrieved, WITH_BOTH);
      expect(withoutSet.citationValidity, chain).toBe(1);
      expect(withoutSet.passed, chain).toBe(true);
    }
  });

  it("does not accept the excluded reports", () => {
    const excludedLabels = HEAD_022.excludedCitations ?? [];
    expect(excludedLabels.length).toBeGreaterThan(0);
    for (const label of excludedLabels) {
      // Each is a report the fixture records as read and ruled out in
      // excludedCitations; neither the opt-in set nor the map accepts it.
      const excluded = score(GS_022.row, [label], GS_022_EXCLUDED_FRAME, WITH_BOTH);
      expect(excluded.citationValidity, label).toBe(0);
      expect(excluded.identitySatisfied?.citationValidity, label).toBe(0);
    }
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

describe("D3 — 008's requirement is the map's same-ruling family, not a loosened substring", () => {
  it("anchors the requirement in the signed same-ruling group", () => {
    const group = identityGroup("same-ruling", requiredAddress(HEAD_008));
    expect(group, "008's requirement anchors a same-ruling map group").toBeDefined();
    for (const alternative of HEAD_008.citationAlternatives ?? []) {
      expect(group?.members, alternative).toContain(alternative);
    }
  });

  it("passes both dimensions through the curated alternative", () => {
    const scored = outcome("gs-v0-008");
    expect(scored.citationValidity).toBe(1); // 5027 is a curator-accepted answer to the question
    expect(scored.citationAddressRecall).toBe(1); // and it was retrieved
    expect(scored.passed).toBe(true);
  });

  it("accepts Tirmidhi 2910 alone through the map, though it is not in the row's set", () => {
    const entry = ROWS["gs-v0-008"];
    const cited = ["HR. Tirmidhi no. 2910"];
    const scored = score(entry.row, cited, entry.retrieved, WITH_BOTH);
    expect(scored.citationValidity).toBe(1); // the same-ruling relation validates it
    expect(scored.citationAddressRecall).toBe(1); // 5027, a set member, was retrieved
    expect(scored.passed).toBe(true);
    // Without the signed map the address is not the row's requirement, so it fails.
    expect(score(entry.row, cited, entry.retrieved).citationValidity).toBe(0);
  });

  it("without the opt-in set the map validates the citation while the exact address stays 0", () => {
    const entry = ROWS["gs-v0-008"];
    const withoutSet = question("gs-v0-008", ["HR. Bukhari no. 5026"]);
    const scored = score(withoutSet, entry.cited, entry.retrieved, WITH_BOTH);
    expect(scored.citationValidity).toBe(1); // 5027 and 4937 are map members
    expect(scored.citationAddressRecall).toBe(0); // the set is what widens the exact leg
    expect(scored.passed).toBe(false);
  });

  it("does not accept a narration the curator read and ruled out", () => {
    const excludedLabels = HEAD_008.excludedCitations ?? [];
    expect(excludedLabels.length).toBeGreaterThan(0);
    for (const label of excludedLabels) {
      const excluded = score(ROWS["gs-v0-008"].row, [label], GS_008_EXCLUDED_FRAME, WITH_BOTH);
      expect(excluded.citationValidity, label).toBe(0);
      expect(excluded.identitySatisfied?.citationValidity, label).toBe(0);
    }
  });

  it("keeps a row whose required address anchors no group on the exact address", () => {
    const frame = [{ label: "HR. Bukhari no. 5029", sourceType: "primary" }];
    const row = question("gs-v0-unanchored", ["HR. Bukhari no. 5029"]);
    const exact = score(row, ["HR. Bukhari no. 5029"], frame, WITH_BOTH);
    expect(exact.citationValidity).toBe(1);
    // A neighbour the map places in another group is not this requirement.
    const neighbour = score(row, ["HR. Bukhari no. 5026"], frame, WITH_BOTH);
    expect(neighbour.citationValidity).toBe(0);
    expect(neighbour.identitySatisfied?.citationValidity).toBe(0);
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
    // 012 moves on the curated verse pair; 006, 008 and 017 move on the map's
    // same-ruling relations; 016 stays red on the exact address this recorded
    // evidence never retrieved, and the reported figure shows it.
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
