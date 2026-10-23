/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  GATING_IDENTITY_RELATIONS,
  REPORTED_IDENTITY_RELATIONS,
  identityResolver,
  parseHadithIdentitySet,
  type HadithIdentitySet,
} from "./hadith-identity";
import { IdentityMapError } from "./identity-map";

/**
 * The identity map's contract: a group is one report (`same-report`) or one
 * ruling stated by different reports (`same-ruling`), and the relation decides who
 * may read it — the gate reads same-report only, the reported identity-satisfied
 * measure reads both. A label outside every group of the requested relations has
 * no identity, so an unrelated or fabricated hadith cannot resolve into a match.
 * The known cases pin the boundary between "another chain of the required hadith",
 * "a different narration stating the same ruling", and "a different hadith on the
 * same subject".
 */

const FIXTURE = new URL("../fixtures/hadith-identities-v0.json", import.meta.url);
const SET: HadithIdentitySet = parseHadithIdentitySet(
  JSON.parse(readFileSync(FIXTURE, "utf8")),
  "hadith-identities-v0",
);
const gateIdentityOf = identityResolver(SET, GATING_IDENTITY_RELATIONS);
const reportedIdentityOf = identityResolver(SET, REPORTED_IDENTITY_RELATIONS);

describe("the shipped identity map", () => {
  it("loads every group with a relation, a rationale and members", () => {
    expect(SET.id).toBe("hadith-identities-v0");
    expect(SET.status).toBe("v0-draft");
    expect(SET.groups.length).toBeGreaterThan(0);
    for (const group of SET.groups) {
      expect(group.id, "a group names its narration").not.toBe("");
      expect(group.canonical, "a group has a canonical label").not.toBe("");
      expect(group.members.length, "a group has at least one parallel").toBeGreaterThan(0);
      expect(["same-report", "same-ruling"]).toContain(group.relation);
      expect(group.rationale, "the group states why it is one identity").not.toBe("");
    }
    expect(SET.groups.filter((group) => group.relation === "same-report")).toHaveLength(5);
    expect(SET.groups.filter((group) => group.relation === "same-ruling")).toHaveLength(2);
  });

  it("classifies the known wudu family as one report", () => {
    const canonical = gateIdentityOf("HR. Bukhari no. 191");
    expect(canonical).not.toBeNull();
    for (const label of [
      "HR. Bukhari no. 185",
      "HR. Bukhari no. 186",
      "HR. Bukhari no. 192",
      "HR. Muslim no. 555",
      "HR. Nasai no. 99",
      "HR. Tirmidhi no. 47",
    ]) {
      expect(gateIdentityOf(label), label).toBe(canonical);
    }
  });

  it("classifies the right-hand eating family as one report", () => {
    const canonical = gateIdentityOf("HR. Muslim no. 5265");
    expect(canonical).not.toBeNull();
    for (const label of [
      "HR. Muslim no. 5264",
      "HR. Malik no. 1676",
      "HR. Abu Dawud no. 3776",
      "HR. Tirmidhi no. 1800",
      "HR. Ibn Majah no. 3266",
    ]) {
      expect(gateIdentityOf(label), label).toBe(canonical);
    }
  });

  it("classifies the zakat report as one identity under the gate (D1a)", () => {
    const canonical = gateIdentityOf("HR. Bukhari no. 1395");
    expect(canonical).toBe("HR. Bukhari no. 1395");
    for (const label of [
      "HR. Abu Dawud no. 1584",
      "HR. Ibn Majah no. 1783",
      "HR. Nasai no. 2522",
      "HR. Nasai no. 2435",
    ]) {
      expect(gateIdentityOf(label), label).toBe(canonical);
    }
  });

  it("keeps the travel group's membership exactly the signed same-report set", () => {
    const group = SET.groups.find(
      (candidate) => candidate.id === "combining-prayers-in-travel-maghrib-isha",
    );
    expect(group?.canonical).toBe("HR. Bukhari no. 1108");
    expect(group?.relation).toBe("same-report");
    expect(group?.members).toEqual([
      "HR. Bukhari no. 1109",
      "HR. Bukhari no. 1110",
      "HR. Muslim no. 1621",
      "HR. Muslim no. 1624",
    ]);
  });

  it("does NOT let the signed same-ruling relation satisfy the gate", () => {
    // Nasai 598 states the same ruling as Bukhari 1108 under another chain; the
    // gate is the exact-address instrument, so the relation must not resolve at
    // all under the gating relations.
    expect(gateIdentityOf("HR. Bukhari no. 1108")).toBe("HR. Bukhari no. 1108");
    expect(gateIdentityOf("HR. Nasai no. 598")).toBeNull();
    // The gold/silk ruling is recorded too, and the gate cannot read it.
    expect(gateIdentityOf("HR. Nasai no. 5144")).toBeNull();
    for (const label of [
      "HR. Nasai no. 5148",
      "HR. Nasai no. 5149",
      "HR. Nasai no. 5160",
      "HR. Ibn Majah no. 3597",
      "HR. Ibn Majah no. 3590",
      "HR. Tirmidhi no. 1720",
    ]) {
      expect(gateIdentityOf(label), label).toBeNull();
    }
  });

  it("resolves the same-ruling relation only for the reported measure", () => {
    const travel = reportedIdentityOf("HR. Bukhari no. 1108");
    expect(travel).not.toBeNull();
    expect(reportedIdentityOf("HR. Nasai no. 598")).toBe(travel);
    // The same-report parallels of 1108 share that key too: the reported relation
    // is the union of the two, so a component cannot split across relations.
    for (const label of [
      "HR. Bukhari no. 1109",
      "HR. Bukhari no. 1110",
      "HR. Muslim no. 1621",
      "HR. Muslim no. 1624",
    ]) {
      expect(reportedIdentityOf(label), label).toBe(travel);
    }

    const gold = reportedIdentityOf("HR. Nasai no. 5144");
    expect(gold).not.toBeNull();
    for (const label of [
      "HR. Nasai no. 5148",
      "HR. Nasai no. 5149",
      "HR. Nasai no. 5160",
      "HR. Ibn Majah no. 3597",
      "HR. Ibn Majah no. 3590",
      "HR. Tirmidhi no. 1720",
    ]) {
      expect(reportedIdentityOf(label), label).toBe(gold);
    }
  });

  it("keeps every other narration a different identity from the travel group", () => {
    const travel = gateIdentityOf("HR. Bukhari no. 1108");
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
      expect(gateIdentityOf(other), other).not.toBe(travel);
    }
    // The map holds five same-report narrations; none of their keys aliases another.
    expect(
      SET.groups
        .filter((group) => group.relation === "same-report")
        .map((group) => group.canonical),
    ).toEqual([
      "HR. Bukhari no. 186",
      "HR. Muslim no. 5265",
      "HR. Muslim no. 534",
      travel,
      "HR. Bukhari no. 1395",
    ]);
  });

  it("keeps a different hadith on the same subject a different identity", () => {
    expect(gateIdentityOf("HR. Muslim no. 534")).not.toBe(gateIdentityOf("HR. Muslim no. 153"));
    expect(gateIdentityOf("HR. Muslim no. 534")).not.toBe(gateIdentityOf("HR. Muslim no. 154"));
    expect(gateIdentityOf("HR. Bukhari no. 1108")).not.toBe(gateIdentityOf("HR. Malik no. 331"));
    expect(gateIdentityOf("HR. Bukhari no. 1108")).not.toBe(gateIdentityOf("HR. Malik no. 326"));
    expect(gateIdentityOf("HR. Bukhari no. 1108")).not.toBe(gateIdentityOf("HR. Muslim no. 1626"));
    expect(gateIdentityOf("HR. Bukhari no. 1108")).not.toBe(gateIdentityOf("HR. Muslim no. 1630"));
    expect(gateIdentityOf("HR. Bukhari no. 1108")).not.toBe(
      gateIdentityOf("HR. Ibn Majah no. 1070"),
    );
    expect(gateIdentityOf("HR. Bukhari no. 191")).not.toBe(gateIdentityOf("HR. Bukhari no. 5026"));
  });

  it("normalizes a grade suffix before resolving, like the citation gate", () => {
    expect(gateIdentityOf("HR. Bukhari no. 191 (Sahih)")).toBe(
      gateIdentityOf("HR. Bukhari no. 191"),
    );
    expect(gateIdentityOf("HR. Muslim no. 534 (Sahih)")).toBe(gateIdentityOf("HR. Muslim no. 534"));
  });

  it("returns null for a label the map does not carry", () => {
    expect(gateIdentityOf("HR. Bukhari no. 99999")).toBeNull();
    expect(gateIdentityOf("HR. Bukhari no. 5026")).toBeNull();
    expect(gateIdentityOf("HR. Bukhari no. 1624")).toBeNull();
    // Numeric neighbours of a member are not the member: membership is curated
    // per corpus row, so no range or proximity widens a group.
    expect(gateIdentityOf("HR. Bukhari no. 1111")).toBeNull();
    expect(gateIdentityOf("HR. Muslim no. 1622")).toBeNull();
    expect(gateIdentityOf("QS. 2:255")).toBeNull();
    expect(gateIdentityOf("")).toBeNull();
  });
});

describe("parseHadithIdentitySet", () => {
  const group = {
    id: "g",
    relation: "same-report",
    canonical: "HR. Bukhari no. 1",
    members: ["HR. Bukhari no. 2"],
    rationale: "one report through two chains",
  };
  const valid = { id: "m", status: "v0-draft", groups: [group] };

  it("accepts a well-formed map", () => {
    expect(parseHadithIdentitySet(valid).groups).toHaveLength(1);
  });

  it("rejects a group that does not state its relation", () => {
    const withoutRelation = { ...group, relation: undefined };
    expect(() => parseHadithIdentitySet({ ...valid, groups: [withoutRelation] })).toThrow(
      /relation must be/,
    );
  });

  it("rejects an unknown relation", () => {
    expect(() =>
      parseHadithIdentitySet({ ...valid, groups: [{ ...group, relation: "same-topic" }] }),
    ).toThrow(/relation must be/);
  });

  it("rejects a group with no rationale: the claim would be unreadable", () => {
    expect(() =>
      parseHadithIdentitySet({ ...valid, groups: [{ ...group, rationale: "  " }] }),
    ).toThrow(/rationale must be a non-empty string/);
  });

  it("rejects a label that is not a hadith citation", () => {
    expect(() =>
      parseHadithIdentitySet({
        ...valid,
        groups: [{ ...group, members: ["QS. 2:255"] }],
      }),
    ).toThrow(IdentityMapError);
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

  it("rejects a label claimed by two groups of one relation", () => {
    expect(() =>
      parseHadithIdentitySet({
        ...valid,
        groups: [group, { ...group, id: "h", canonical: "HR. Bukhari no. 3" }],
      }),
    ).toThrow(/already claimed/);
  });

  it("allows one label in a same-report group and a same-ruling group", () => {
    // The two claims are different (one report vs one ruling), so a canonical may
    // anchor both; the reported resolver unions the component.
    const map = {
      ...valid,
      groups: [
        group,
        {
          id: "ruling",
          relation: "same-ruling",
          canonical: "HR. Bukhari no. 1",
          members: ["HR. Bukhari no. 9"],
          rationale: "same ruling under another chain",
        },
      ],
    };
    const parsed = parseHadithIdentitySet(map);
    expect(parsed.groups).toHaveLength(2);
    const reported = identityResolver(parsed, REPORTED_IDENTITY_RELATIONS);
    expect(reported("HR. Bukhari no. 9")).toBe(reported("HR. Bukhari no. 2"));
    expect(identityResolver(parsed, GATING_IDENTITY_RELATIONS)("HR. Bukhari no. 9")).toBeNull();
  });

  it("rejects a member with no companion", () => {
    expect(() => parseHadithIdentitySet({ ...valid, groups: [{ ...group, members: [] }] })).toThrow(
      IdentityMapError,
    );
  });

  it("rejects a member that repeats the canonical", () => {
    expect(() =>
      parseHadithIdentitySet({
        ...valid,
        groups: [{ ...group, members: ["HR. Bukhari no. 1"] }],
      }),
    ).toThrow(IdentityMapError);
  });

  it("rejects an unknown status", () => {
    expect(() => parseHadithIdentitySet({ ...valid, status: "draft" })).toThrow(IdentityMapError);
  });
});
