import { describe, expect, it } from "bun:test";
import { addressKey, scoreUnits, validateUnits, type EvidenceUnit } from "./evidence-units";

const ref = (label: string) => ({ label, address: label });

const JAMAK: EvidenceUnit = {
  unitId: "unit.jamak-safar",
  kind: "hadith",
  members: [ref("HR. Bukhari no. 1108"), ref("HR. Nasai no. 598"), ref("HR. Muslim no. 1621")],
  canonical: ref("HR. Bukhari no. 1108"),
};

const VERSE: EvidenceUnit = {
  unitId: "unit.tanzih",
  kind: "quran",
  members: [ref("QS. 42:11")],
  canonical: ref("QS. 42:11"),
};

describe("addressKey", () => {
  it("folds case, punctuation and spacing", () => {
    expect(addressKey("QS. 2:255")).toBe(addressKey("qs 2 255"));
    expect(addressKey("HR. Bukhari no. 1108")).toBe(addressKey("hr. bukhari no.1108"));
  });

  it("folds a sub-numbered address and a verse range to the parent", () => {
    expect(addressKey("HR. Bukhari no. 3756.2")).toBe(addressKey("HR. Bukhari no. 3756"));
    expect(addressKey("QS. 2:255-256")).toBe(addressKey("QS. 2:255"));
  });

  it("keeps different collections apart", () => {
    expect(addressKey("HR. Nasai no. 598")).not.toBe(addressKey("HR. Bukhari no. 598"));
  });
});

describe("validateUnits", () => {
  it("accepts a well-formed unit set", () => {
    expect(validateUnits([JAMAK, VERSE])).toEqual([]);
  });

  it("rejects a canonical that is not a member", () => {
    const broken = { ...JAMAK, canonical: ref("HR. Bukhari no. 9999") };
    expect(validateUnits([broken])).toEqual([
      "unit.jamak-safar: canonical is not one of its members",
    ]);
  });

  it("rejects an address claimed by two units", () => {
    const overlapping: EvidenceUnit = {
      unitId: "unit.other",
      kind: "hadith",
      members: [ref("HR. Nasai no. 598")],
      canonical: ref("HR. Nasai no. 598"),
    };
    expect(validateUnits([JAMAK, overlapping])).toEqual([
      "address hr:nasai:598 belongs to both unit.jamak-safar and unit.other",
    ]);
  });

  it("rejects a unit with no members", () => {
    const empty: EvidenceUnit = {
      unitId: "unit.empty",
      kind: "hadith",
      members: [],
      canonical: ref("HR. Bukhari no. 1"),
    };
    expect(validateUnits([empty])).toEqual([
      "unit.empty: no members",
      "unit.empty: canonical is not one of its members",
    ]);
  });
});

describe("scoreUnits", () => {
  const retrieved = [
    { address: "HR. Nasai no. 598", text: "..." },
    { address: "QS. 1:1", text: "..." },
  ];

  it("strict accepts only the canonical address", () => {
    expect(scoreUnits([JAMAK], retrieved, "strict")).toEqual([
      { unitId: "unit.jamak-safar", satisfied: false },
    ]);
  });

  it("equivalent accepts a member and says how it matched", () => {
    expect(scoreUnits([JAMAK], retrieved, "equivalent")).toEqual([
      {
        unitId: "unit.jamak-safar",
        satisfied: true,
        matched: ref("HR. Nasai no. 598"),
        relation: "member",
      },
    ]);
  });

  it("reports the canonical relation when the canonical row was retrieved", () => {
    const evidence = [{ address: "HR. Bukhari no. 1108", text: "..." }];
    expect(scoreUnits([JAMAK], evidence, "equivalent")).toEqual([
      {
        unitId: "unit.jamak-safar",
        satisfied: true,
        matched: ref("HR. Bukhari no. 1108"),
        relation: "canonical",
      },
    ]);
  });

  it("fails closed on evidence no unit claims", () => {
    expect(scoreUnits([VERSE], retrieved, "equivalent")).toEqual([
      { unitId: "unit.tanzih", satisfied: false },
    ]);
  });
});
