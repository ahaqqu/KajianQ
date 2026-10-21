/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { citationValidity } from "../../packages/eval/src/scorers";
import {
  addressesNamedBy,
  citationCandidatesIn,
  identityResolver,
  normalizeCitationLabel,
  parseHadithIdentitySet,
} from "../../packages/kajianq-domain/src/index";

/**
 * The recorded full Golden Set run's citation evidence, replayed through the
 * head scorer and the curated hadith-identity map. The fixture snapshots the
 * labels the run's citations frame carried, not the answer prose: the frame is
 * the scorer's authoritative evidence path, so these are the labels the
 * recorded `citationValidity` was computed from.
 *
 * The rows pin the boundary the identity rule has to hold: a parallel narration
 * of the required hadith scores 1, a different hadith on the same subject stays
 * 0, and a Quran citation is untouched by the hadith map. The last two rows are
 * the falsification: the required narration still scores 1, and an unrelated
 * hadith still scores 0.
 */

const IDENTITIES = parseHadithIdentitySet(
  JSON.parse(
    readFileSync(
      new URL("../../packages/kajianq-domain/fixtures/hadith-identities-v0.json", import.meta.url),
      "utf8",
    ),
  ),
  "hadith-identities-v0",
);
const identity = { identityOf: identityResolver(IDENTITIES) };

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
    why: "1624 is the same Maghrib/Isha travel practice as 1108; the other five are different prayer pairs or broader Tabuk reports",
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
    expected: 0,
    why: "the merit-of-recitation hadiths are different narrations, not chains of 5026",
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
    expected: 0,
    why: "the identity map is hadith-only; the absent Quran verse stays absent",
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
    expect(moved.map((row) => row.questionId)).toEqual(["gs-v0-003", "gs-v0-006", "gs-v0-013"]);
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
