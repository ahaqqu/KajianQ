import { describe, expect, it } from "vite-plus/test";
import { matnKeyOf } from "./sanadset-ingest-content";
import { buildSanadsetPlan, PILOT_SCOPE } from "./sanadset-ingest-plan";
import {
  buildPlanArtifact,
  sampleArtifactGroups,
  sampleQuarantineRows,
} from "./sanadset-ingest-plan-artifact";
import type { ExistingChildRow } from "./sanadset-ingest-match";
import {
  prepareRows,
  sourceRow,
  MATN_A,
  MATN_B,
  MATN_C,
} from "./test-utils/sanadset-pilot-fixture";

/**
 * Test intent, named before the assertions:
 * - trap: the artifact is the plan, not a summary. Every group must carry its
 *   target and every quarantine row its rule/detail, or the dry run cannot show
 *   which narration a chain lands on;
 * - trap: a matched child must be identifiable after the fact. Its immutable text
 *   digest is in the record, so the same seed can be checked on a later run;
 * - trap: the report's sample must not let one rule hide another, and a new group
 *   must not crowd a target out. Groups are ordered with a new one first here, so
 *   a plain slice and the target-first selection are distinguishable; quarantine
 *   sampling round-robins across rules, with one rule repeated first.
 */

const FILLER =
  "قال حدثنا أخبرنا عن ابن عمر أن رسول الله صلى الله عليه وسلم ذكر حديثا طويلا في مجلس " +
  "من مجلس العلم والذكر ثم سأله رجل عن معنى ذلك فبينه له بيانا شافيا ثم انصرف القوم";
const MATN_D = "اتقوا النار ولو بشق تمرة";
const MATN_E = "من غشنا فليس منا";

function child(id: string, textRaw: string): ExistingChildRow {
  return { id, textRaw, collection: "bukhari" };
}

const CHILDREN: readonly ExistingChildRow[] = [
  child("exact-child", MATN_A),
  child("ambiguous-a", `${MATN_C} ا`),
  child("ambiguous-b", `${MATN_C} ب`),
  child("long-child", `حدثنا مالك بن أنس عن نافع قال: ${MATN_B} ${FILLER} ${FILLER} ${FILLER}`),
];

function rows() {
  return prepareRows([
    sourceRow({ rowIndex: 0, hadithNumber: "1", matn: MATN_E }),
    sourceRow({ rowIndex: 1, hadithNumber: "2" }),
    sourceRow({ rowIndex: 2, hadithNumber: "3", matn: MATN_B }),
    sourceRow({ rowIndex: 3, hadithNumber: "4", matn: MATN_C }),
    sourceRow({ rowIndex: 4, hadithNumber: "5", matn: MATN_D }),
    sourceRow({ rowIndex: 5, hadithNumber: "6", sanadLength: null }),
    sourceRow({ rowIndex: 6, hadithNumber: "7", sanadLength: null }),
    sourceRow({ rowIndex: 7, hadithNumber: "8", matn: "" }),
  ]);
}

async function artifact() {
  const slice = rows();
  const plan = await buildSanadsetPlan({
    scope: PILOT_SCOPE,
    rows: slice.prepared,
    sourceQuarantined: slice.quarantined,
    stats: slice.stats,
    children: CHILDREN,
    childrenCapHit: false,
  });
  return {
    plan,
    artifact: buildPlanArtifact({
      runId: "s2-bukhari-test",
      dryRun: true,
      plan,
      children: CHILDREN,
      source: { fileName: "sanadset.csv", sha256: "b".repeat(64), recordsRead: 8 },
    }),
  };
}

describe("the pilot plan artifact", () => {
  it("writes every group's target and every quarantine row's rule and detail", async () => {
    const { plan, artifact: built } = await artifact();
    expect(built.groups).toHaveLength(plan.groups.length);
    expect(built.groups.map((group) => group.target.kind)).toEqual([
      "new",
      "existing",
      "fragmentary",
      "ambiguous",
      "new",
    ]);
    expect(built.counts.byTarget).toEqual({
      existing: 1,
      new: 2,
      ambiguous: 1,
      fragmentary: 1,
      truncated: 0,
    });
    expect(built.quarantine).toHaveLength(plan.quarantine.rows.length);
    expect(built.quarantine.every((row) => row.detail.trim() !== "")).toBe(true);
    const rules = built.quarantine.map((row) => row.rule);
    expect(rules.filter((rule) => rule === "invalid_sanad_length")).toHaveLength(2);
    expect(rules).toContain("empty_matn");
    expect(rules).toContain("fragmentary_containment");
    expect(built.thresholds).toEqual(plan.thresholds);
    expect(built.source?.recordsRead).toBe(8);
  });

  it("names the matched child by its immutable text digest", async () => {
    const { artifact: built } = await artifact();
    const exact = built.groups.find((group) => group.target.kind === "existing")?.target;
    expect(exact?.childId).toBe("exact-child");
    expect(exact?.childTextSha256).toBe(matnKeyOf(MATN_A));
    expect(exact?.how).toBe("exact");
    expect(exact?.score).toBe(1);

    const fragment = built.groups.find((group) => group.target.kind === "fragmentary")?.target;
    expect(fragment?.childId).toBe("long-child");
    expect(fragment?.childTextSha256).toBeDefined();
    expect(fragment?.reason).toContain("stored narration");

    const ambiguous = built.groups.find((group) => group.target.kind === "ambiguous")?.target;
    expect(ambiguous?.candidates).toEqual(["ambiguous-a", "ambiguous-b"]);
  });

  it("keeps a refused group's rows out of the members and chains", async () => {
    const { plan, artifact: built } = await artifact();
    const fragment = built.groups.find((group) => group.target.kind === "fragmentary");
    expect(fragment?.memberRows).toEqual([]);
    expect(plan.chains.some((entry) => entry.groupId === fragment?.groupId)).toBe(false);
    expect(plan.children.created.map((entry) => entry.groupId)).not.toContain(fragment?.groupId);
  });

  it("samples targets ahead of a new group and quarantine rows round-robin across rules", async () => {
    const { artifact: built } = await artifact();
    const groups = sampleArtifactGroups(built, 2);
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.target.kind !== "new")).toBe(true);

    const quarantine = sampleQuarantineRows(built.quarantine, 2);
    expect(quarantine).toHaveLength(2);
    expect(new Set(quarantine.map((row) => row.rule)).size).toBe(2);
  });
});
