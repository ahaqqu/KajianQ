/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  HadithIdentityError,
  identityResolver,
  parseHadithIdentitySet,
  type HadithIdentitySet,
} from "./hadith-identity";

/**
 * The identity map's contract: a group is one narration across its chains, the
 * resolver answers with the group's canonical label, and a label outside every
 * group has no identity — so an unrelated or fabricated hadith cannot resolve
 * into a match. The known cases pin the boundary between "another chain of the
 * required hadith" and "a different hadith on the same subject".
 */

const FIXTURE = new URL("../fixtures/hadith-identities-v0.json", import.meta.url);
const SET: HadithIdentitySet = parseHadithIdentitySet(
  JSON.parse(readFileSync(FIXTURE, "utf8")),
  "hadith-identities-v0",
);
const identityOf = identityResolver(SET);

describe("the shipped identity map", () => {
  it("loads every group with a hadith-citation canonical and members", () => {
    expect(SET.id).toBe("hadith-identities-v0");
    expect(SET.status).toBe("v0-draft");
    expect(SET.groups.length).toBeGreaterThan(0);
    for (const group of SET.groups) {
      expect(group.id, "a group names its narration").not.toBe("");
      expect(group.canonical, "a group has a canonical label").not.toBe("");
      expect(group.members.length, "a group has at least one parallel").toBeGreaterThan(0);
    }
  });

  it("classifies the known wudu family as one narration", () => {
    const canonical = identityOf("HR. Bukhari no. 191");
    expect(canonical).not.toBeNull();
    for (const label of [
      "HR. Bukhari no. 185",
      "HR. Bukhari no. 186",
      "HR. Bukhari no. 192",
      "HR. Muslim no. 555",
      "HR. Nasai no. 99",
      "HR. Tirmidhi no. 47",
    ]) {
      expect(identityOf(label), label).toBe(canonical);
    }
  });

  it("classifies the right-hand eating family as one narration", () => {
    const canonical = identityOf("HR. Muslim no. 5265");
    expect(canonical).not.toBeNull();
    for (const label of [
      "HR. Muslim no. 5264",
      "HR. Malik no. 1676",
      "HR. Abu Dawud no. 3776",
      "HR. Tirmidhi no. 1800",
      "HR. Ibn Majah no. 3266",
    ]) {
      expect(identityOf(label), label).toBe(canonical);
    }
  });

  it("classifies the travel Maghrib/Isha family as one narration", () => {
    const canonical = identityOf("HR. Bukhari no. 1108");
    expect(canonical).toBe("HR. Bukhari no. 1108");
    for (const label of [
      "HR. Bukhari no. 1109",
      "HR. Bukhari no. 1110",
      "HR. Muslim no. 1621",
      "HR. Muslim no. 1624",
    ]) {
      expect(identityOf(label), label).toBe(canonical);
    }
  });

  it("keeps the travel group's membership exactly the signed set", () => {
    const group = SET.groups.find(
      (candidate) => candidate.id === "combining-prayers-in-travel-maghrib-isha",
    );
    expect(group?.canonical).toBe("HR. Bukhari no. 1108");
    expect(group?.members).toEqual([
      "HR. Bukhari no. 1109",
      "HR. Bukhari no. 1110",
      "HR. Muslim no. 1621",
      "HR. Muslim no. 1624",
    ]);
  });

  it("keeps every other narration a different identity from the travel group", () => {
    const travel = identityOf("HR. Bukhari no. 1108");
    // Another narration — even one on the same subject — never shares this
    // identity: the merit-of-recitation hadith 5026, the wudu demonstration 186,
    // the right-hand eating instruction, purity is half of faith, and the travel
    // rows that narrate another prayer pair rather than a chain of this report.
    for (const other of [
      "HR. Bukhari no. 5026",
      "HR. Bukhari no. 186",
      "HR. Muslim no. 5265",
      "HR. Muslim no. 534",
      "HR. Muslim no. 1626",
      "HR. Muslim no. 1627",
      "HR. Muslim no. 1630",
      "HR. Malik no. 326",
      "HR. Malik no. 331",
      "HR. Ibn Majah no. 1070",
    ]) {
      expect(identityOf(other), other).not.toBe(travel);
    }
    // The map holds four narrations; none of their keys aliases another.
    const keys = ["HR. Bukhari no. 186", "HR. Muslim no. 5265", "HR. Muslim no. 534", travel];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps a different hadith on the same subject a different identity", () => {
    expect(identityOf("HR. Muslim no. 534")).not.toBe(identityOf("HR. Muslim no. 153"));
    expect(identityOf("HR. Muslim no. 534")).not.toBe(identityOf("HR. Muslim no. 154"));
    expect(identityOf("HR. Bukhari no. 1108")).not.toBe(identityOf("HR. Malik no. 331"));
    expect(identityOf("HR. Bukhari no. 1108")).not.toBe(identityOf("HR. Malik no. 326"));
    expect(identityOf("HR. Bukhari no. 1108")).not.toBe(identityOf("HR. Muslim no. 1626"));
    expect(identityOf("HR. Bukhari no. 1108")).not.toBe(identityOf("HR. Muslim no. 1630"));
    expect(identityOf("HR. Bukhari no. 1108")).not.toBe(identityOf("HR. Ibn Majah no. 1070"));
    expect(identityOf("HR. Bukhari no. 191")).not.toBe(identityOf("HR. Bukhari no. 5026"));
  });

  it("normalizes a grade suffix before resolving, like the citation gate", () => {
    expect(identityOf("HR. Bukhari no. 191 (Sahih)")).toBe(identityOf("HR. Bukhari no. 191"));
    expect(identityOf("HR. Muslim no. 534 (Sahih)")).toBe(identityOf("HR. Muslim no. 534"));
  });

  it("returns null for a label the map does not carry", () => {
    expect(identityOf("HR. Bukhari no. 99999")).toBeNull();
    expect(identityOf("HR. Bukhari no. 5026")).toBeNull();
    expect(identityOf("HR. Bukhari no. 1624")).toBeNull();
    // Numeric neighbours of a member are not the member: membership is curated
    // per corpus row, so no range or proximity widens a group.
    expect(identityOf("HR. Bukhari no. 1111")).toBeNull();
    expect(identityOf("HR. Muslim no. 1622")).toBeNull();
    expect(identityOf("QS. 2:255")).toBeNull();
    expect(identityOf("")).toBeNull();
  });
});

describe("parseHadithIdentitySet", () => {
  const group = {
    id: "g",
    canonical: "HR. Bukhari no. 1",
    members: ["HR. Bukhari no. 2"],
  };
  const valid = { id: "m", status: "v0-draft", groups: [group] };

  it("accepts a well-formed map", () => {
    expect(parseHadithIdentitySet(valid).groups).toHaveLength(1);
  });

  it("rejects a label that is not a hadith citation", () => {
    expect(() =>
      parseHadithIdentitySet({
        ...valid,
        groups: [{ ...group, members: ["QS. 2:255"] }],
      }),
    ).toThrow(HadithIdentityError);
  });

  it("rejects a dash-joined range: one key names one corpus row, not two", () => {
    // The citation grammar keeps a dash compound whole on purpose (fail-closed
    // for the gate), so a range parses as one label — but a map key has to name
    // exactly one row, or a curation mistake silently widens what matches.
    for (const range of ["HR. Bukhari no. 191-192", "HR. Bukhari no. 191—192"]) {
      expect(() =>
        parseHadithIdentitySet({ ...valid, groups: [{ ...group, canonical: range }] }),
      ).toThrow(/not a single hadith citation/);
      expect(() =>
        parseHadithIdentitySet({ ...valid, groups: [{ ...group, members: [range] }] }),
      ).toThrow(/not a single hadith citation/);
    }
  });

  it("rejects a number no corpus row carries (a glued letter, not an integer)", () => {
    // The corpus renders the number from `hadithNo`, an integer; `no. 5010a`
    // is a spelling no row holds, so it can never be a group's key.
    expect(() =>
      parseHadithIdentitySet({
        ...valid,
        groups: [{ ...group, members: ["HR. Bukhari no. 5010a"] }],
      }),
    ).toThrow(/not a single hadith citation/);
  });

  it("rejects a zero-padded number: no row renders it, and it folds to no key", () => {
    // `no. 0191` normalizes to a different key than `no. 191`, so the padded
    // spelling would be a dead identity that no evidence label resolves — one
    // that also claims a row the duplicate check cannot see it claim.
    for (const padded of ["HR. Bukhari no. 0191", "HR. Bukhari no. 0000000191"]) {
      expect(() =>
        parseHadithIdentitySet({ ...valid, groups: [{ ...group, canonical: padded }] }),
      ).toThrow(/not a single hadith citation/);
      expect(() =>
        parseHadithIdentitySet({ ...valid, groups: [{ ...group, members: [padded] }] }),
      ).toThrow(/not a single hadith citation/);
    }
  });

  it("accepts a graded label — the number is still one corpus row", () => {
    const graded = { ...valid, groups: [{ ...group, canonical: "HR. Bukhari no. 1 (Sahih)" }] };
    expect(parseHadithIdentitySet(graded).groups[0]?.canonical).toBe("HR. Bukhari no. 1 (Sahih)");
  });

  it("rejects a duplicated group id, which would merge two narrations' claims", () => {
    expect(() =>
      parseHadithIdentitySet({
        ...valid,
        groups: [group, { ...group, canonical: "HR. Bukhari no. 3" }],
      }),
    ).toThrow(/group id "g" is already used/);
  });

  it("rejects a label claimed by two groups", () => {
    expect(() =>
      parseHadithIdentitySet({
        ...valid,
        groups: [group, { ...group, id: "h", canonical: "HR. Bukhari no. 3" }],
      }),
    ).toThrow(/already claimed/);
  });

  it("rejects a member with no companion", () => {
    expect(() => parseHadithIdentitySet({ ...valid, groups: [{ ...group, members: [] }] })).toThrow(
      HadithIdentityError,
    );
  });

  it("rejects a member that repeats the canonical", () => {
    expect(() =>
      parseHadithIdentitySet({
        ...valid,
        groups: [{ ...group, members: ["HR. Bukhari no. 1"] }],
      }),
    ).toThrow(HadithIdentityError);
  });

  it("rejects an unknown status", () => {
    expect(() => parseHadithIdentitySet({ ...valid, status: "draft" })).toThrow(
      HadithIdentityError,
    );
  });
});
