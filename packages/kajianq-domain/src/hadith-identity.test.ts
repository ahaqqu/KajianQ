/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  GATING_IDENTITY_RELATIONS,
  identityResolver,
  parseHadithIdentitySet,
  type HadithIdentitySet,
} from "./hadith-identity";
import { IdentityMapError } from "./identity-map";

/**
 * The identity map's contract: a group is one report (`same-report`) or one
 * ruling/instruction/merit stated by different reports (`same-ruling`), and both
 * are gate identities — a citation of either carries the required narration's
 * identity. A label outside every group of the requested relations has no
 * identity, so an unrelated or fabricated hadith cannot resolve into a match. The
 * known cases pin the boundary between "another chain of the required hadith", "a
 * different narration stating the same ruling", and "a different hadith on the
 * same subject".
 */

const FIXTURE = new URL("../fixtures/hadith-identities-v0.json", import.meta.url);
const SET: HadithIdentitySet = parseHadithIdentitySet(
  JSON.parse(readFileSync(FIXTURE, "utf8")),
  "hadith-identities-v0",
);
const gateIdentityOf = identityResolver(SET, GATING_IDENTITY_RELATIONS);

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
    expect(SET.groups.filter((group) => group.relation === "same-report")).toHaveLength(12);
    expect(SET.groups.filter((group) => group.relation === "same-ruling")).toHaveLength(4);
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
      "HR. Bukhari no. 1496",
      "HR. Bukhari no. 4347",
      "HR. Abu Dawud no. 1584",
      "HR. Ibn Majah no. 1783",
      "HR. Muslim no. 121",
      "HR. Muslim no. 123",
      "HR. Nasai no. 2522",
      "HR. Nasai no. 2435",
      "HR. Tirmidhi no. 625",
    ]) {
      expect(gateIdentityOf(label), label).toBe(canonical);
    }
    // The zakat schedule (Abu Bakr's letter) is a different report and ruling.
    expect(gateIdentityOf("HR. Bukhari no. 1454")).toBeNull();
  });

  it("classifies the seeking-knowledge report as one identity under the gate", () => {
    const canonical = gateIdentityOf("HR. Tirmidhi no. 2646");
    expect(canonical).toBe("HR. Tirmidhi no. 2646");
    for (const label of [
      "HR. Abu Dawud no. 3643",
      "HR. Ibn Majah no. 225",
      "HR. Muslim no. 6853",
      "HR. Tirmidhi no. 2945",
    ]) {
      expect(gateIdentityOf(label), label).toBe(canonical);
    }
    // The Abu Darda report states the same ruling through another companion's
    // chain, and 224 ("seeking knowledge is obligatory") is a different narration
    // graded dhaif; neither is a chain of the Abu Hurayra report.
    for (const label of [
      "HR. Tirmidhi no. 2682",
      "HR. Ibn Majah no. 223",
      "HR. Ibn Majah no. 224",
    ]) {
      expect(gateIdentityOf(label), label).toBeNull();
    }
  });

  it("keeps the travel group's same-report membership to the Anas chains", () => {
    const group = SET.groups.find(
      (candidate) => candidate.id === "combining-prayers-in-travel-maghrib-isha",
    );
    expect(group?.canonical).toBe("HR. Bukhari no. 1108");
    expect(group?.relation).toBe("same-report");
    expect(group?.members).toEqual(["HR. Bukhari no. 1110"]);
    // 1108's matn names 1110's chain as its own follow-up, so the two are one report.
    expect(gateIdentityOf("HR. Bukhari no. 1110")).toBe(gateIdentityOf("HR. Bukhari no. 1108"));
    // The Ibn Umar rows are different reports of the same ruling: the gate reads
    // the signed relation, so they resolve to the same component as 1108 even
    // though they are not chains of the Anas report.
    const travel = gateIdentityOf("HR. Bukhari no. 1108");
    for (const label of [
      "HR. Nasai no. 598",
      "HR. Bukhari no. 1109",
      "HR. Muslim no. 1621",
      "HR. Muslim no. 1624",
      "HR. Ibn Majah no. 1070",
    ]) {
      expect(gateIdentityOf(label), label).toBe(travel);
    }
  });

  it("classifies the mother-precedence report's chains and its same-ruling reports", () => {
    const report = gateIdentityOf("HR. Bukhari no. 5971");
    expect(report).toBe("HR. Bukhari no. 5971");
    // The Abu Hurayra rows reach the same 'Umarah ← Abu Zur'a chain: one report.
    for (const label of [
      "HR. Muslim no. 6500",
      "HR. Muslim no. 6501",
      "HR. Muslim no. 6502",
      "HR. Muslim no. 6503",
      "HR. Ibn Majah no. 2706",
      "HR. Ibn Majah no. 3658",
    ]) {
      expect(gateIdentityOf(label), label).toBe(report);
    }
    const ruling = gateIdentityOf("HR. Bukhari no. 5971");
    expect(ruling).not.toBeNull();
    // The Bahz and Miqdam reports state the same instruction through other
    // companions; the gate reads the signed relation, so it accepts them beside
    // the Abu Hurayra report's chains.
    for (const label of [
      "HR. Abu Dawud no. 5139",
      "HR. Tirmidhi no. 1897",
      "HR. Ibn Majah no. 3661",
    ]) {
      expect(gateIdentityOf(label), label).toBe(ruling);
    }
    // The Daif reports of the same instruction are in no group of either relation.
    for (const label of ["HR. Ibn Majah no. 3657", "HR. Abu Dawud no. 5140"]) {
      expect(gateIdentityOf(label), label).toBeNull();
    }
  });

  it("classifies Ali's gold-and-silk report as one identity under the gate", () => {
    const canonical = gateIdentityOf("HR. Nasai no. 5144");
    expect(canonical).not.toBeNull();
    for (const label of [
      "HR. Nasai no. 5145",
      "HR. Nasai no. 5146",
      "HR. Nasai no. 5147",
      "HR. Abu Dawud no. 4057",
      "HR. Ibn Majah no. 3595",
    ]) {
      expect(gateIdentityOf(label), label).toBe(canonical);
    }
  });

  it("lets the signed same-ruling relation satisfy the gate", () => {
    // Nasai 598 states the same ruling as Bukhari 1108 under another chain; the
    // gate reads the signed relation, so it resolves to the same identity.
    expect(gateIdentityOf("HR. Bukhari no. 1108")).toBe("HR. Bukhari no. 1108");
    expect(gateIdentityOf("HR. Nasai no. 598")).toBe("HR. Bukhari no. 1108");
    // The gold/silk ruling resolves too: the Ali chains, the Abu Musa chains and
    // the 'Abdullah ibn 'Amr report are one component under the gate.
    const ali = gateIdentityOf("HR. Nasai no. 5144");
    expect(ali).not.toBeNull();
    for (const label of [
      "HR. Nasai no. 5145",
      "HR. Nasai no. 5148",
      "HR. Nasai no. 5265",
      "HR. Ibn Majah no. 3597",
      "HR. Tirmidhi no. 1720",
    ]) {
      expect(gateIdentityOf(label), label).toBe(ali);
    }
    // Ibn Majah 3590 states the prohibition without the male/female clause, so
    // it is not a member of the men/women ruling: neither relation reads it.
    expect(gateIdentityOf("HR. Ibn Majah no. 3590")).toBeNull();
    // The exception narrations are in no group of either relation.
    for (const label of ["HR. Nasai no. 5149", "HR. Nasai no. 5160"]) {
      expect(gateIdentityOf(label), label).toBeNull();
    }
  });

  it("classifies the Qur'an-virtue family as one ruling (008)", () => {
    const family = gateIdentityOf("HR. Bukhari no. 5026");
    expect(family).toBe("HR. Bukhari no. 5026");
    // Tirmidhi 2910 states the merit of recitation through Ibn Mas'ud: the
    // relation the draws cited and the probe showed the gate rejecting.
    expect(gateIdentityOf("HR. Tirmidhi no. 2910")).toBe(family);
    for (const label of [
      "HR. Bukhari no. 5025",
      "HR. Bukhari no. 5027",
      "HR. Tirmidhi no. 2909",
      "HR. Bukhari no. 4937",
      "HR. Muslim no. 1874",
      "HR. Tirmidhi no. 2914",
      "HR. Ibn Majah no. 3780",
    ]) {
      expect(gateIdentityOf(label), label).toBe(family);
    }
    // The same-report chains merge into the same component.
    for (const label of [
      "HR. Muslim no. 1894",
      "HR. Muslim no. 1895",
      "HR. Bukhari no. 7529",
      "HR. Tirmidhi no. 1936",
      "HR. Ibn Majah no. 4209",
      "HR. Bukhari no. 5028",
      "HR. Tirmidhi no. 2907",
      "HR. Tirmidhi no. 2908",
      "HR. Abu Dawud no. 1452",
      "HR. Ibn Majah no. 211",
      "HR. Ibn Majah no. 212",
      "HR. Muslim no. 1862",
      "HR. Abu Dawud no. 1454",
      "HR. Ibn Majah no. 3779",
      "HR. Abu Dawud no. 1464",
    ]) {
      expect(gateIdentityOf(label), label).toBe(family);
    }
    // A merit the curator read and ruled out stays its own identity: a dhaif
    // narration, a specific-surah merit, a parable, and the wisdom wording.
    for (const label of [
      "HR. Ibn Majah no. 213",
      "HR. Tirmidhi no. 2905",
      "HR. Tirmidhi no. 2883",
      "HR. Bukhari no. 5015",
      "HR. Bukhari no. 5020",
      "HR. Bukhari no. 5023",
      "HR. Bukhari no. 5031",
      "HR. Bukhari no. 73",
      "HR. Muslim no. 1896",
    ]) {
      expect(gateIdentityOf(label), label).toBeNull();
    }
  });

  it("resolves both signed relations under the gate", () => {
    const travel = gateIdentityOf("HR. Bukhari no. 1108");
    expect(travel).not.toBeNull();
    expect(gateIdentityOf("HR. Nasai no. 598")).toBe(travel);
    // The same-report parallels and the same-ruling rows share that key too: the
    // requested relations are the union, so a component cannot split across them.
    for (const label of [
      "HR. Bukhari no. 1109",
      "HR. Bukhari no. 1110",
      "HR. Muslim no. 1621",
      "HR. Muslim no. 1624",
    ]) {
      expect(gateIdentityOf(label), label).toBe(travel);
    }

    const gold = gateIdentityOf("HR. Nasai no. 5144");
    expect(gold).not.toBeNull();
    for (const label of [
      "HR. Nasai no. 5145",
      "HR. Nasai no. 5146",
      "HR. Nasai no. 5147",
      "HR. Nasai no. 5148",
      "HR. Nasai no. 5265",
      "HR. Ibn Majah no. 3597",
      "HR. Ibn Majah no. 3595",
      "HR. Tirmidhi no. 1720",
      "HR. Abu Dawud no. 4057",
    ]) {
      expect(gateIdentityOf(label), label).toBe(gold);
    }

    // Ibn Majah 1070 is the Mu'adh report of the travel ruling, not a chain of
    // the Anas report: the gate reads the signed same-ruling relation.
    expect(gateIdentityOf("HR. Ibn Majah no. 1070")).toBe(travel);
  });

  it("reads a relation only when the caller requests it", () => {
    // The gate's relation list is the declaration that decides this; a caller
    // asking for same-report alone gets no same-ruling identity. This is the
    // boundary the gating constant exists to state, kept testable directly.
    const reportOnly = identityResolver(SET, ["same-report"]);
    expect(reportOnly("HR. Bukhari no. 1108")).toBe("HR. Bukhari no. 1108");
    expect(reportOnly("HR. Nasai no. 598")).toBeNull();
    expect(reportOnly("HR. Tirmidhi no. 2910")).toBeNull();
  });

  it("keeps every other narration a different identity from the travel group", () => {
    const travel = gateIdentityOf("HR. Bukhari no. 1108");
    // Another narration — even one on the same subject — never shares this gate
    // identity: the merit-of-recitation report 5026, the wudu demonstration 186,
    // the right-hand eating instruction, purity is half of faith, and the travel
    // rows that state another prayer pair rather than the signed ruling.
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
    ]) {
      expect(gateIdentityOf(other), other).not.toBe(travel);
    }
    // The map holds twelve same-report narrations; none of their keys aliases another.
    expect(
      SET.groups
        .filter((group) => group.relation === "same-report")
        .map((group) => group.canonical),
    ).toEqual([
      "HR. Bukhari no. 186",
      "HR. Muslim no. 5265",
      "HR. Muslim no. 534",
      travel,
      "HR. Bukhari no. 5971",
      "HR. Bukhari no. 1395",
      "HR. Tirmidhi no. 2646",
      "HR. Nasai no. 5144",
      "HR. Bukhari no. 5025",
      "HR. Bukhari no. 5027",
      "HR. Bukhari no. 4937",
      "HR. Tirmidhi no. 2914",
    ]);
  });

  it("keeps a different hadith on the same subject a different identity", () => {
    expect(gateIdentityOf("HR. Muslim no. 534")).not.toBe(gateIdentityOf("HR. Muslim no. 153"));
    expect(gateIdentityOf("HR. Muslim no. 534")).not.toBe(gateIdentityOf("HR. Muslim no. 154"));
    expect(gateIdentityOf("HR. Bukhari no. 1108")).not.toBe(gateIdentityOf("HR. Malik no. 331"));
    expect(gateIdentityOf("HR. Bukhari no. 1108")).not.toBe(gateIdentityOf("HR. Malik no. 326"));
    expect(gateIdentityOf("HR. Bukhari no. 1108")).not.toBe(gateIdentityOf("HR. Muslim no. 1626"));
    expect(gateIdentityOf("HR. Bukhari no. 1108")).not.toBe(gateIdentityOf("HR. Muslim no. 1630"));
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
    expect(gateIdentityOf("HR. Bukhari no. 5029")).toBeNull();
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

  it("rejects a malformed map or one of its groups", () => {
    // The map-level failure names the map with a colon; the entry-level failure
    // names its path without one.
    expect(() => parseHadithIdentitySet(null)).toThrow(/^matn identity set: must be an object$/);
    expect(() => parseHadithIdentitySet({ ...valid, groups: [null] })).toThrow(
      /^matn identity set: groups\[0\] must be an object$/,
    );
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
    // anchor both; the union makes 9 and 2 one component.
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
    const gating = identityResolver(parsed, GATING_IDENTITY_RELATIONS);
    expect(gating("HR. Bukhari no. 9")).toBe(gating("HR. Bukhari no. 2"));
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
