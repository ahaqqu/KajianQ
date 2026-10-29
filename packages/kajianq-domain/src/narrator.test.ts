import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import type { NarratorRecord } from "@app/infra";
import { GRADES, type Grade } from "./filters";
import {
  asIsnad,
  asNarrator,
  NarratorShapeError,
  parseNarratorReliability,
  type CriticAssessment,
} from "./narrator";

/**
 * The domain pack's graph types are a **refusal boundary**: a row whose reliability
 * map or grade the pack cannot read under its contract is an error, not a null.
 * The silent failure they guard is an answer rendering "trusted (no source)" from a
 * malformed map, or a grade the vocabulary does not contain passing as if it did —
 * both would look like sourced jarh wa ta'dil to a reader.
 */

const narratorRow = (overrides: Partial<NarratorRecord> = {}): NarratorRecord => ({
  id: "11111111-1111-4111-8111-111111111111",
  canonicalNameAr: "الاسم",
  nameVariants: [],
  kunya: null,
  laqab: null,
  deathYear: null,
  tabaqa: null,
  reliabilityByCritic: {},
  metadata: {},
  ...overrides,
});

const chainRow = (grade: string | null) => ({
  id: "22222222-2222-4222-8222-222222222222",
  childId: "33333333-3333-4333-8333-333333333333",
  collection: "bukhari",
  narratorIds: ["44444444-4444-4444-8444-444444444444"],
  grade,
  grader: grade === null ? null : "grader-a",
  sourceRef: null,
});

describe("the reliability map the pack accepts", () => {
  it("reads a well-formed critic map, keeping its keys and optional fields", () => {
    const assessment: CriticAssessment = {
      verdict: "trusted",
      sourceRef: "work, vol. 1, p. 2",
      note: "with a qualifier",
    };
    expect(
      parseNarratorReliability({ "critic-a": assessment, "critic-b": { verdict: "weak" } }),
    ).toEqual({ "critic-a": assessment, "critic-b": { verdict: "weak" } });
    // An empty map is the honest "no assessment recorded", not an error.
    expect(parseNarratorReliability({})).toEqual({});
  });

  it("tolerates extra keys on an entry, so a producer can extend the payload", () => {
    expect(parseNarratorReliability({ "critic-a": { verdict: "v", rank: 3 } })).toEqual({
      "critic-a": { verdict: "v" },
    });
  });

  it("refuses every shape a citation could not source", () => {
    const refused: unknown[] = [
      null,
      [],
      "trusted",
      { "critic-a": null },
      { "critic-a": "trusted" },
      { "critic-a": {} },
      { "critic-a": { verdict: "" } },
      { "critic-a": { verdict: "   " } },
      { "critic-a": { verdict: 3 } },
      { "critic-a": { verdict: "v", sourceRef: 5 } },
      { "critic-a": { verdict: "v", note: false } },
      { "  ": { verdict: "v" } },
    ];
    for (const value of refused) {
      expect(() => parseNarratorReliability(value)).toThrow(NarratorShapeError);
    }
  });

  it("maps a narrator row through the same refusal", () => {
    const valid = narratorRow({
      reliabilityByCritic: { "critic-a": { verdict: "trusted", sourceRef: "work-a" } },
    });
    expect(asNarrator(valid).reliabilityByCritic).toEqual({
      "critic-a": { verdict: "trusted", sourceRef: "work-a" },
    });
    expect(() =>
      asNarrator(narratorRow({ reliabilityByCritic: { "critic-a": { sourceRef: "work-a" } } })),
    ).toThrow(NarratorShapeError);
  });
});

describe("the isnad grade the pack accepts", () => {
  it("narrows every value of the domain's Grade vocabulary, and null", () => {
    expect(asIsnad(chainRow(null)).grade).toBeNull();
    for (const grade of GRADES) {
      expect(asIsnad(chainRow(grade)).grade).toBe(grade satisfies Grade);
    }
  });

  it("refuses a grade outside the vocabulary rather than coercing it", () => {
    for (const grade of ["sahih ", "Sahih", "sahih hasan", ""]) {
      expect(() => asIsnad(chainRow(grade))).toThrow(NarratorShapeError);
    }
  });

  it("keeps the ordered narrator sequence untouched", () => {
    const row = { ...chainRow("sahih"), narratorIds: ["b", "a", "b"] };
    expect(asIsnad(row).narratorIds).toEqual(["b", "a", "b"]);
  });
});
