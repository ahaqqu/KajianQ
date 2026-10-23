/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { citationAddressRecall, sourceTypeRecall } from "../../packages/eval/src/scorers";
import {
  addressesNamedBy,
  DEFAULT_SCOPE_EXPANSION_CAP,
  normalizeCitationLabel,
  SURAH_AYAH_COUNTS,
} from "../../packages/kajianq-domain/src/index";
import { shortSurahsAmong } from "../../packages/kajianq-domain/src/chat-surah-completion";

/**
 * Address recall measured on the recorded full-set run whose retrieval is
 * snapshotted in `golden-set-v0-replay.json`. The fixture's rows carry the exact
 * chunks the run's last retrieval event returned (the corpus's own citation
 * label and source type), so the two metrics can be compared on the same
 * evidence without a live model call: source-type recall is what the run
 * reported, address recall is what it should have reported.
 *
 * It lives under `tests/` because the question set and the citation grammar
 * belong to the domain pack and the scorers to the engine. The grammar is the
 * domain's own — the same functions the staging composition root injects — so
 * the comparison form here cannot drift from the gate's.
 */

const REPLAY = JSON.parse(
  readFileSync(
    new URL("../../packages/kajianq-domain/fixtures/golden-set-v0-replay.json", import.meta.url),
    "utf8",
  ),
).rows;

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("../../packages/kajianq-domain/fixtures/golden-set-v0.json", import.meta.url),
    "utf8",
  ),
);

const GRAMMAR = {
  normalizeLabel: normalizeCitationLabel,
  labelsInText: () => [],
  addressesNamedBy,
};

const requiredById = new Map(
  FIXTURE.questions.map((question) => [question.id, question.requiredCitations]),
);

const refsOf = (row) => row.retrieved.map((_, index) => ({ id: `c${index}` }));
const sourceTypeOf = (row) => (id) => row.retrieved[Number(id.slice(1))]?.sourceType ?? undefined;
const citationOf = (row) => (id) => row.retrieved[Number(id.slice(1))]?.label ?? undefined;

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

const typeRecallOf = (row) =>
  sourceTypeRecall(row.expectedSourceTypes, refsOf(row), sourceTypeOf(row));
const addressRecallOf = (row) =>
  citationAddressRecall(requiredById.get(row.questionId), refsOf(row), citationOf(row), {
    grammar: GRAMMAR,
  });

describe("recorded run — the two retrieval metrics", () => {
  it("carries the whole recorded run", () => {
    expect(REPLAY.length).toBe(20);
    expect(REPLAY.every((row) => row.retrieved.length > 0)).toBe(true);
  });

  it("reports source-type recall 1.000 — the number the run printed", () => {
    expect(REPLAY.every((row) => typeRecallOf(row) === 1)).toBe(true);
    expect(mean(REPLAY.map(typeRecallOf))).toBeCloseTo(1, 3);
  });

  it("reports address recall 0.700 on the same retrieved sets", () => {
    // Six questions reached a source of the required type without reaching the
    // fixture's required address. Every one of them still scores 1 on type
    // recall: that gap is exactly what the type-only metric cannot see.
    const missed = REPLAY.filter((row) => addressRecallOf(row) < 1).map((row) => row.questionId);
    expect(missed).toEqual([
      "gs-v0-006",
      "gs-v0-007",
      "gs-v0-008",
      "gs-v0-011",
      "gs-v0-012",
      "gs-v0-016",
    ]);
    expect(mean(REPLAY.map(addressRecallOf))).toBeCloseTo(0.7, 3);
    for (const row of REPLAY) {
      if (addressRecallOf(row) < 1) expect(typeRecallOf(row), row.questionId).toBe(1);
    }
  });

  it("breaks out the eight rows the issue names, under the fixture at head", () => {
    // The recorded run's own fixture has since been re-curated on five rows; this
    // table scores the recorded retrieval against the addresses the set requires
    // now. Three of the eight (003, 013, 017) name an address the run did return;
    // five still miss it.
    const expected = new Map([
      ["gs-v0-003", "HR. Bukhari no. 191"],
      ["gs-v0-007", "QS. 42:11"],
      ["gs-v0-008", "HR. Bukhari no. 5026"],
      ["gs-v0-011", "HR. Muslim no. 534"],
      ["gs-v0-012", "QS. 1:1"],
      ["gs-v0-013", "HR. Muslim no. 5265"],
      ["gs-v0-016", "HR. Bukhari no. 1395"],
      ["gs-v0-017", "HR. Nasai no. 5144"],
    ]);
    const hits = [];
    for (const [questionId, required] of expected) {
      expect(requiredById.get(questionId), questionId).toEqual([required]);
      const row = REPLAY.find((candidate) => candidate.questionId === questionId);
      const hit = addressRecallOf(row) === 1;
      expect(typeRecallOf(row), `${questionId}: the source type was still reached`).toBe(1);
      hits.push([questionId, hit]);
    }
    expect(hits.filter(([, hit]) => hit).map(([questionId]) => questionId)).toEqual([
      "gs-v0-003",
      "gs-v0-013",
      "gs-v0-017",
    ]);
  });

  it("reads 0.750 once the short-surah completion is applied to the recorded set", () => {
    // An address-union MODEL of the recorded set, not a live-run prediction: the
    // target surahs come from the recorded labels and the read is the corpus's own
    // surah rows, capped by the configured budget. A live run completes before the
    // neighbourhood arm, so a completion chunk can become an anchor the recorded
    // run never had and the arm can then add an address the completion alone did
    // not (the gs-v0-009 shape); the model also ignores the named read's spend
    // inside the shared cap, because the fixture carries no origins. The one row
    // this metric moves names no reference and is not truncated, so its union is
    // identical either way — the 0.750 is the recorded set's, not a live promise.
    const completed = REPLAY.map((row) => {
      const verses = row.retrieved.flatMap((entry, index) => {
        const match = /^QS\. (\d+):(\d+)$/.exec(entry.label ?? "");
        if (match === null) return [];
        return [
          {
            id: `c${index}`,
            text: "",
            metadata: { sourceType: "quran", surah: Number(match[1]) },
          },
        ];
      });
      const added = [];
      const held = new Set(row.retrieved.map((entry) => entry.label));
      for (const surah of shortSurahsAmong(verses, DEFAULT_SCOPE_EXPANSION_CAP)) {
        const count = SURAH_AYAH_COUNTS[surah - 1] ?? 0;
        for (let ayah = 1; ayah <= count && added.length < DEFAULT_SCOPE_EXPANSION_CAP; ayah += 1) {
          const label = `QS. ${surah}:${ayah}`;
          if (!held.has(label)) added.push(label);
        }
      }
      const refs = [...refsOf(row), ...added.map((_, index) => ({ id: `a${index}` }))];
      const labelOf = (id) =>
        id.startsWith("a")
          ? added[Number(id.slice(1))]
          : (row.retrieved[Number(id.slice(1))]?.label ?? undefined);
      const recall = citationAddressRecall(requiredById.get(row.questionId), refs, labelOf, {
        grammar: GRAMMAR,
      });
      return { questionId: row.questionId, recall };
    });
    expect(mean(completed.map((row) => row.recall))).toBeCloseTo(0.75, 3);
    expect(completed.filter((row) => row.recall < 1).map((row) => row.questionId)).toEqual([
      "gs-v0-006",
      "gs-v0-007",
      "gs-v0-008",
      "gs-v0-011",
      "gs-v0-016",
    ]);
    // Exactly one recorded row moves: the Basmalah its own surah's opening holds.
    const moved = completed.filter(
      (row, index) => (row.recall === 1) !== (addressRecallOf(REPLAY[index]) === 1),
    );
    expect(moved.map((row) => row.questionId)).toEqual(["gs-v0-012"]);
  });
});
