/// <reference types="node" />
import { describe, expect, it } from "vite-plus/test";
import { citationValidity } from "../../packages/eval/src/scorers";
import {
  addressesNamedBy,
  citationCandidatesIn,
  curatedIdentityResolvers,
  normalizeCitationLabel,
} from "../../packages/kajianq-domain/src/index";

/**
 * The recorded full Golden Set run's citation evidence, replayed through the
 * head scorer and the curated identity maps in the gate's own composition: the
 * narration map's signed groups of both relations, plus the curated verse pairs.
 * A `same-report` group is a parallel chain; a `same-ruling` group is another
 * report stating the required ruling. Both are gate identities, and exact-address
 * recall stays exact.
 *
 * The resolver comes from the domain pack's one loader, the same wiring `eval:run`
 * runs, so this replay cannot pass against a composition production does not use.
 *
 * The rows pin the boundary the identity rule has to hold: a parallel narration
 * of the required report scores 1, a report stating the same ruling scores 1, a
 * report on the same subject with a different wording stays 0, and the curated
 * verse pair carries the two names of the basmalah. The last two rows are the
 * falsification: the required narration still scores 1, and an unrelated report
 * still scores 0.
 */

const { gating: identity } = curatedIdentityResolvers();

/** The domain's own citation grammar, injected here as the composition root does. */
const grammar = {
  normalizeLabel: normalizeCitationLabel,
  labelsInText: citationCandidatesIn,
  addressesNamedBy,
};

const ROWS = [
  {
    questionId: "gs-v0-003",
    required: ["HR. Bukhari no. 191"],
    evidence: [
      "HR. Bukhari no. 186",
      "HR. Abu Dawud no. 135",
      "HR. Bukhari no. 192",
      "HR. Abu Dawud no. 138",
      "HR. Nasai no. 99",
    ],
    expected: 1,
    why: "186 and 192 are parallel chains of the Abdullah bin Zaid demonstration 191 narrates",
  },
  {
    questionId: "gs-v0-006",
    required: ["HR. Bukhari no. 1108"],
    evidence: [
      "HR. Malik no. 331",
      "HR. Muslim no. 1626",
      "HR. Malik no. 326",
      "HR. Ibn Majah no. 1070",
      "HR. Muslim no. 1624",
      "HR. Muslim no. 1630",
    ],
    expected: 1,
    why: "1624 and 1070 state the travel ruling the map signs as a same-ruling group of 1108; 1626 and 1630 are other prayer pairs and stay out",
  },
  {
    questionId: "falsification — a different travel prayer pair",
    required: ["HR. Bukhari no. 1108"],
    evidence: ["HR. Malik no. 331", "HR. Muslim no. 1626"],
    expected: 0,
    why: "the same subject does not make another prayer pair the required narration",
  },
  {
    questionId: "gs-v0-013",
    required: ["HR. Muslim no. 5265"],
    evidence: [
      "HR. Malik no. 1676",
      "HR. Muslim no. 5264",
      "HR. Abu Dawud no. 3767",
      "HR. Bukhari no. 5376",
      "HR. Ibn Majah no. 3266",
      "HR. Ibn Majah no. 3427",
      "HR. Muslim no. 5279",
      "HR. Tirmidhi no. 1879",
    ],
    expected: 1,
    why: "1676, 5264, and 3266 narrate the same right-hand eating instruction as 5265",
  },
  {
    questionId: "gs-v0-011",
    required: ["HR. Muslim no. 534"],
    evidence: [
      "HR. Muslim no. 534",
      "HR. Tirmidhi no. 3517",
      "HR. Ibn Majah no. 280",
      "HR. Nasai no. 2437",
      "HR. Tirmidhi no. 3519",
    ],
    expected: 1,
    why: "the required label itself is present; the identity map does not need to widen it",
  },
  {
    questionId: "gs-v0-008",
    required: ["HR. Bukhari no. 5026"],
    evidence: [
      "HR. Muslim no. 1874",
      "HR. Tirmidhi no. 2910",
      "HR. Abu Dawud no. 1454",
      "HR. Tirmidhi no. 2914",
      "HR. Ibn Majah no. 3780",
      "HR. Tirmidhi no. 2883",
      "HR. Tirmidhi no. 2905",
    ],
    expected: 1,
    why: "1874, 2910, 2914 and 3780 state the recitation merit the map signs as a same-ruling group of 5026; 2883 and 2905 state other merits and stay out",
  },
  {
    questionId: "gs-v0-012",
    required: ["QS. 1:1"],
    evidence: [
      "QS. 55:1",
      "QS. 44:42",
      "QS. 1:3",
      "HR. Abu Dawud no. 1694",
      "HR. Tirmidhi no. 1924",
    ],
    expected: 1,
    why: "1:3 is the curated pair of 1:1 — the two names in the basmalah — and the frame carries it; the other labels are unrelated reports",
  },
  {
    questionId: "falsification — the required narration",
    required: ["HR. Bukhari no. 191"],
    evidence: ["HR. Bukhari no. 186"],
    expected: 1,
    why: "a parallel chain of the required narration is the case the rule exists to accept",
  },
  {
    questionId: "falsification — an unrelated hadith",
    required: ["HR. Bukhari no. 191"],
    evidence: ["HR. Bukhari no. 5026"],
    expected: 0,
    why: "a hadith outside the narration family must never resolve into a match",
  },
];

describe("recorded run replay — citation identity", () => {
  for (const row of ROWS) {
    it(`${row.questionId}: ${row.why}`, () => {
      expect(
        citationValidity(row.required, "", {
          frame: { citations: row.evidence.map((label) => ({ label })) },
          grammar,
          identity,
        }),
      ).toBe(row.expected);
    });
  }

  it("flips the recorded run's parallel-narration zeros, not its unrelated-citation zeros", () => {
    const moved = ROWS.filter((row) => row.questionId.startsWith("gs-v0-")).filter(
      (row) =>
        citationValidity(row.required, "", {
          frame: { citations: row.evidence.map((label) => ({ label })) },
          grammar,
          identity,
        }) !==
        citationValidity(row.required, "", {
          frame: { citations: row.evidence.map((label) => ({ label })) },
          grammar,
        }),
    );
    expect(moved.map((row) => row.questionId)).toEqual([
      "gs-v0-003",
      "gs-v0-006",
      "gs-v0-013",
      "gs-v0-008",
      "gs-v0-012",
    ]);
  });

  it("flips the falsification row the rule exists to accept, and only with the map", () => {
    const frame = { citations: [{ label: "HR. Bukhari no. 186" }] };
    expect(citationValidity(["HR. Bukhari no. 191"], "", { frame, grammar })).toBe(0);
    expect(citationValidity(["HR. Bukhari no. 191"], "", { frame, grammar, identity })).toBe(1);
  });

  it("keeps a refusal invalid: an empty frame grounds nothing", () => {
    expect(
      citationValidity(["HR. Bukhari no. 191"], "I could not find adequate evidence", {
        frame: { citations: [] },
        grammar,
        identity,
      }),
    ).toBe(0);
  });
});

/**
 * A `gs-v0-006` frame carrying the rows the map signs as the travel ruling beside
 * the rows no relation holds. The signed same-ruling members resolve under the
 * gate; the other prayer pairs and the excluded neighbours stay their own
 * identities, so the frame's unrelated zeros remain zeros.
 */
const TRAVEL_ANSWER_FRAME = [
  "HR. Bukhari no. 1109",
  "HR. Muslim no. 1621",
  "HR. Muslim no. 1626",
  "HR. Muslim no. 1627",
  "HR. Muslim no. 1630",
  "HR. Malik no. 326",
  "HR. Malik no. 331",
  "HR. Abu Dawud no. 1218",
  "HR. Tirmidhi no. 553",
  "HR. Tirmidhi no. 188",
  "HR. Ibn Majah no. 1070",
  "HR. Ibn Majah no. 1194",
  "HR. Nasai no. 597",
  "HR. Nasai no. 588",
];

describe("the travel group's corrected relations", () => {
  it("scores the Ibn Umar parallels as the same ruling under the gate", () => {
    const frame = { citations: TRAVEL_ANSWER_FRAME.map((label) => ({ label })) };
    expect(citationValidity(["HR. Bukhari no. 1108"], "", { frame, grammar, identity })).toBe(1);
    const travel = identity.identityOf("HR. Bukhari no. 1108");
    expect(travel).not.toBeNull();
    expect(identity.identityOf("HR. Bukhari no. 1109")).toBe(travel);
    expect(identity.identityOf("HR. Muslim no. 1621")).toBe(travel);
  });

  it("scores the Anas report's own follow-up chain (Bukhari 1110) as the report", () => {
    const frame = { citations: [{ label: "HR. Bukhari no. 1110" }] };
    expect(citationValidity(["HR. Bukhari no. 1108"], "", { frame, grammar })).toBe(0);
    expect(citationValidity(["HR. Bukhari no. 1108"], "", { frame, grammar, identity })).toBe(1);
  });

  it("resolves the Ibn Umar rows as the same ruling through the one signed resolver", () => {
    const { gating, reported } = curatedIdentityResolvers();
    // The reported block reads the gate's own resolver; only the leg it widens differs.
    expect(reported).toBe(gating);
    const travel = reported.identityOf("HR. Bukhari no. 1108");
    expect(travel).not.toBeNull();
    for (const label of [
      "HR. Nasai no. 598",
      "HR. Bukhari no. 1109",
      "HR. Muslim no. 1621",
      "HR. Muslim no. 1624",
      "HR. Ibn Majah no. 1070",
    ]) {
      expect(reported.identityOf(label), label).toBe(travel);
      expect(identity.identityOf(label), label).toBe(travel);
    }
  });

  it("keeps the frame's unmapped travel rows out of the group one by one", () => {
    for (const label of TRAVEL_ANSWER_FRAME.filter(
      (candidate) =>
        candidate !== "HR. Bukhari no. 1109" &&
        candidate !== "HR. Muslim no. 1621" &&
        candidate !== "HR. Ibn Majah no. 1070",
    )) {
      expect(identity.identityOf(label), label).toBeNull();
      expect(
        citationValidity(["HR. Bukhari no. 1108"], "", {
          frame: { citations: [{ label }] },
          grammar,
          identity,
        }),
        label,
      ).toBe(0);
    }
  });

  it("scores the recorded row's mapped evidence and leaves its unmapped rows out", () => {
    const row = ROWS.find((candidate) => candidate.questionId === "gs-v0-006");
    expect(row).toBeDefined();
    const travel = identity.identityOf("HR. Bukhari no. 1108");
    for (const label of row.evidence) {
      const validated = citationValidity(row.required, "", {
        frame: { citations: [{ label }] },
        grammar,
        identity,
      });
      expect(validated, label).toBe(identity.identityOf(label) === travel ? 1 : 0);
    }
  });

  it("accepts Tirmidhi 2910 alone as 5026's same ruling, and only with the map", () => {
    const required = ["HR. Bukhari no. 5026"];
    const frame = { citations: [{ label: "HR. Tirmidhi no. 2910" }] };
    expect(citationValidity(required, "", { frame, grammar })).toBe(0);
    expect(citationValidity(required, "", { frame, grammar, identity })).toBe(1);
  });
});
