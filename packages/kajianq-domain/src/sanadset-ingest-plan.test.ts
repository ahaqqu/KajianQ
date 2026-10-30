import { describe, expect, it } from "vite-plus/test";
import { buildSanadsetPlan, PILOT_SCOPE, type IngestPlan } from "./sanadset-ingest-plan";
import type { ExistingChildRow } from "./sanadset-ingest-match";
import { createPrepareAccumulator, SLICE_BOOKS, type SanadsetSourceRow } from "./sanadset-prepare";
import { jaccard, matnTrigrams, normalizeMatnText } from "./sanadset-text";

/**
 * Test intent, named before the assertions:
 * - trap: a matn that exists in another book is not this book's child. The plan is
 *   asserted to ignore a Muslim child carrying the identical text while matching the
 *   Bukhari child with it — a global group book would put a Bukhari isnad on a Muslim
 *   narration, and nothing downstream could tell;
 * - trap: a quarantined row must leave no chain and no child. The plan's chain list is
 *   asserted to be exactly the surviving rows, so a quarantine that only appears in a
 *   count while the row still writes is red;
 * - trap: a target that ties between two stored children is quarantined whole. The
 *   fixture's two scores are pinned first, so the ambiguity case cannot silently stop
 *   being ambiguous and pass while exercising nothing;
 * - trap: two different names that block alike are two narrators with an uncertain
 *   pair reported, never one narrator;
 * - trap: the plan must be deterministic — the same input builds the same plan, or a
 *   re-run could write a different corpus from the same archive.
 */

const BUKHARI = SLICE_BOOKS[0];
const MUSLIM = SLICE_BOOKS[1];

const MATN_A =
  "إنما الأعمال بالنيات وإنما لكل امرئ ما نوى فمن كانت هجرته إلى الله ورسوله فهجرته إلى الله ورسوله";
const MATN_B = "من حسن إسلام المرء تركه ما لا يعنيه";
const MATN_C = "لا يؤمن أحدكم حتى يحب لأخيه ما يحب لنفسه";

function chainLiteral(names: readonly string[]): string {
  return `[${names.map((name) => `'${name}'`).join(", ")}]`;
}

function sourceRow(overrides: Partial<SanadsetSourceRow> = {}): SanadsetSourceRow {
  return {
    rowIndex: 0,
    book: BUKHARI,
    hadithNumber: "1",
    hadith: `<SANAD>…</SANAD> <MATN> ${MATN_A} </MATN>`,
    matn: MATN_A,
    sanad: chainLiteral(["مالك بن أنس", "نافع", "عبد الله بن عمر"]),
    sanadLength: 3,
    ...overrides,
  };
}

function prepare(rows: readonly SanadsetSourceRow[]) {
  const accumulator = createPrepareAccumulator();
  for (const row of rows) accumulator.push(row);
  return accumulator.finish();
}

async function planFor(
  rows: readonly SanadsetSourceRow[],
  children: readonly ExistingChildRow[] = [],
): Promise<IngestPlan> {
  const slice = prepare(rows);
  return buildSanadsetPlan({
    scope: PILOT_SCOPE,
    rows: slice.prepared,
    sourceQuarantined: slice.quarantined,
    stats: slice.stats,
    children,
    childrenCapHit: false,
  });
}

function child(id: string, textRaw: string, collection = "bukhari"): ExistingChildRow {
  return { id, textRaw, collection };
}

describe("the pilot plan", () => {
  it("never targets another book's child, even on an identical matn", async () => {
    const rows = [
      sourceRow({ rowIndex: 0 }),
      sourceRow({ rowIndex: 1, book: MUSLIM, hadithNumber: "2" }),
    ];
    const plan = await planFor(rows, [child("muslim-child", MATN_A, "muslim")]);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.target).toEqual({ kind: "new" });
    expect(plan.children.compared).toBe(0);
    expect(plan.children.created).toHaveLength(1);
    expect(plan.chains.map((entry) => entry.rowIndex)).toEqual([0]);
    // The Muslim row is not in the Bukhari scope: its chain is not planned at all.
    expect(plan.slice.rows).toBe(1);
    expect(plan.slice.prepared).toBe(1);
  });

  it("attaches the group to the same book's stored child", async () => {
    const plan = await planFor([sourceRow()], [child("bukhari-child", MATN_A)]);
    expect(plan.groups[0]?.target).toEqual({
      kind: "existing",
      childId: "bukhari-child",
      how: "exact",
      score: 1,
    });
    expect(plan.children.created).toHaveLength(0);
    expect(plan.matchRate).toEqual({ scope: "v1-corpus", matchedRows: 1, rows: 1, value: 1 });
  });

  it("writes no chain and creates no child for a prepare-quarantined row", async () => {
    const rows = [
      sourceRow({ rowIndex: 0 }),
      sourceRow({ rowIndex: 1, hadithNumber: "2", sanadLength: null }),
      sourceRow({ rowIndex: 2, hadithNumber: "3", sanadLength: 40 }),
    ];
    const plan = await planFor(rows);
    expect(plan.slice.rows).toBe(3);
    expect(plan.slice.prepared).toBe(1);
    expect(plan.quarantine.total).toBe(2);
    expect(plan.quarantine.byRule).toEqual({
      invalid_sanad_length: 1,
      implausible_chain_length: 1,
    });
    expect(plan.chains.map((entry) => entry.rowIndex)).toEqual([0]);
    expect(plan.groups).toHaveLength(1);
    expect(plan.children.created).toHaveLength(1);
  });

  it("quarantines a group whose target ties between two stored children", async () => {
    // Two children one letter apart at the end, both close to the source matn: the
    // fixture's scores are pinned so this case is provably inside the ambiguity margin.
    const first = `${MATN_A} ا`;
    const second = `${MATN_A} ب`;
    const query = matnTrigrams(normalizeMatnText(MATN_A));
    const firstScore = jaccard(query, matnTrigrams(normalizeMatnText(first)));
    const secondScore = jaccard(query, matnTrigrams(normalizeMatnText(second)));
    expect(firstScore).toBeGreaterThanOrEqual(0.9);
    expect(secondScore).toBeGreaterThanOrEqual(0.9);
    expect(Math.abs(firstScore - secondScore)).toBeLessThanOrEqual(0.02);

    const plan = await planFor([sourceRow()], [child("child-a", first), child("child-b", second)]);
    expect(plan.groups[0]?.target.kind).toBe("ambiguous");
    expect(plan.children.ambiguous).toBe(1);
    expect(plan.children.created).toHaveLength(0);
    expect(plan.chains).toHaveLength(0);
    expect(plan.quarantine.byRule).toEqual({ ambiguous_best_match: 1 });
    expect(plan.quarantine.rows[0]?.detail).toContain("child-a");
    expect(plan.matchRate.matchedRows).toBe(0);
  });

  it("records folded spelling variants on one name cluster", async () => {
    const rows = [
      sourceRow({ rowIndex: 0, sanadLength: 2, sanad: chainLiteral(["مَالِكُ بْنُ أَنَس", "نافع"]) }),
      sourceRow({ rowIndex: 1, sanadLength: 2, sanad: chainLiteral(["مالك بن أنس", "سالم"]) }),
    ];
    const plan = await planFor(rows);
    const malik = plan.narrators.narrators.find((narrator) => narrator.folded === "مالك بن انس");
    expect(malik).toBeDefined();
    // The canonical spelling is the most frequent surface; the other is a recorded variant.
    expect(malik?.canonical).toBe("مالك بن أنس");
    expect(malik?.variants).toEqual(["مَالِكُ بْنُ أَنَس"]);
    expect(malik?.identityKey).toBe("narrator:folded-name:مالك بن انس");
    expect(plan.narrators.identityBasis).toBe("folded-name");
    expect(plan.narrators.foldedNames).toBe(3);
    expect(plan.narrators.foldedVariants).toBe(1);
  });

  it("keeps two names that block alike as two narrators with an uncertain pair", async () => {
    const rows = [
      sourceRow({
        rowIndex: 0,
        sanadLength: 2,
        sanad: chainLiteral(["عبد الله بن عمر", "نافع"]),
      }),
      sourceRow({
        rowIndex: 1,
        sanadLength: 2,
        sanad: chainLiteral(["عمر بن عبد الله", "سالم"]),
      }),
    ];
    const plan = await planFor(rows);
    const names = plan.narrators.narrators.map((narrator) => narrator.folded);
    expect(names).toContain("عبد الله بن عمر");
    expect(names).toContain("عمر بن عبد الله");
    expect(plan.narrators.uncertainPairs).toContainEqual({
      stratum: "narrator_blocking_same",
      a: "عبد الله بن عمر",
      b: "عمر بن عبد الله",
    });
    expect(plan.narrators.uncertainByStratum["narrator_blocking_same"]).toBe(1);
  });

  it("does not dedupe a chain: the archive concatenates parallel isnads", async () => {
    const rows = [
      sourceRow({
        rowIndex: 0,
        sanadLength: 4,
        sanad: chainLiteral(["نافع", "عبد الله بن عمر", "نافع", "عبد الله بن عمر"]),
      }),
    ];
    const plan = await planFor(rows);
    expect(plan.chains[0]?.foldedChain).toEqual([
      "نافع",
      "عبد الله بن عمر",
      "نافع",
      "عبد الله بن عمر",
    ]);
    expect(plan.chains[0]?.sourceRef).toBe("sanadset:row:0");
    // Two names, not four: the same narrator is one row and is named twice in the chain.
    expect(plan.narrators.narrators.map((narrator) => narrator.folded).sort()).toEqual([
      "عبد الله بن عمر",
      "نافع",
    ]);
  });

  it("keeps the cascade's group order as the child ordinal, gaps included", async () => {
    const rows = [
      sourceRow({ rowIndex: 0, hadithNumber: "1" }),
      sourceRow({ rowIndex: 1, hadithNumber: "2", matn: MATN_B }),
      sourceRow({ rowIndex: 2, hadithNumber: "3", matn: MATN_C }),
    ];
    const plan = await planFor(rows, [child("child-b", MATN_B)]);
    expect(plan.groups.map((group) => group.groupId)).toEqual([0, 1, 2]);
    const created = plan.children.created;
    // The middle group matched a stored child; the others keep their cascade position.
    expect(created.map((entry) => entry.ordinal)).toEqual([0, 2]);
    expect(created.map((entry) => entry.groupId)).toEqual([0, 2]);
  });

  it("builds the same plan twice from the same input", async () => {
    const rows = [
      sourceRow({ rowIndex: 0 }),
      sourceRow({ rowIndex: 1, matn: MATN_B, sanadLength: 2 }),
    ];
    const first = await planFor(rows, [child("child-a", MATN_A)]);
    const second = await planFor(rows, [child("child-a", MATN_A)]);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
