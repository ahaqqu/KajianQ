import { describe, expect, it } from "bun:test";
import fixture from "../packages/kajianq-domain/fixtures/golden-set-v0.json";
import proposals from "./equivalence-proposals.json";
import { addressKey, validateUnits } from "./evidence-units";

const required = (fixture.questions ?? []).flatMap((question) =>
  (question.requiredCitations ?? []).map(addressKey),
);

describe("equivalence proposals", () => {
  it("every proposed unit is well formed", () => {
    const units = proposals.units.map((unit) => ({
      unitId: unit.unitId,
      kind: unit.kind as "hadith",
      members: unit.members,
      canonical: unit.canonical,
    }));
    expect(validateUnits(units)).toEqual([]);
  });

  it("every canonical address is one the fixture requires", () => {
    for (const unit of proposals.units) {
      expect(required, unit.unitId).toContain(addressKey(unit.canonical.address));
    }
  });

  it("every member is a different address from its canonical", () => {
    for (const unit of proposals.units) {
      const keys = unit.members.map((member) => addressKey(member.address));
      expect(new Set(keys).size, unit.unitId).toBe(keys.length);
    }
  });
});
