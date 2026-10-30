import { describe, expect, it } from "vite-plus/test";
import {
  buildSanadsetPlan,
  PILOT_SCOPE,
  resolvePilotCollection,
  type IngestPlan,
} from "./sanadset-ingest-plan";
import type { ExistingChildRow } from "./sanadset-ingest-match";
import { createPrepareAccumulator, SLICE_BOOKS, type SanadsetSourceRow } from "./sanadset-prepare";
import { jaccard, matnTrigrams, normalizeMatnText } from "./sanadset-text";
import { fullNarration } from "./test-utils/sanadset-pilot-fixture";

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

const BUKHARI = PILOT_SCOPE.book;
function otherBook(): (typeof SLICE_BOOKS)[number] {
  const other = SLICE_BOOKS.find((book) => book !== PILOT_SCOPE.book);
  if (other === undefined) throw new Error("the slice no longer carries the other book");
  return other;
}
const MUSLIM = otherBook();

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
  it("pins the book/collection pair by value, not by the slice array's order", () => {
    // A reorder of SLICE_BOOKS must not retarget the pilot: the literal is the
    // contract, and the collection key beside it names the corpus rows it reads.
    expect(PILOT_SCOPE.book).toBe("صحيح البخاري");
    expect(PILOT_SCOPE.collection).toBe("bukhari");
    expect(PILOT_SCOPE.key).toBe("bukhari");
    expect(SLICE_BOOKS).toContain(PILOT_SCOPE.book);
    expect(resolvePilotCollection("bukhari")).toEqual(PILOT_SCOPE);
  });

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

  it("pins the thresholds the plan was built with", async () => {
    // The dry run writes these into the plan artifact; a refused target must be
    // readable against the rule that refused it, not against today's constants.
    const plan = await planFor([sourceRow()]);
    expect(plan.thresholds).toEqual({
      autoMatch: 0.9,
      ambiguityMargin: 0.02,
      containment: {
        minTokens: 4,
        minChars: 16,
        minTokenCoverage: 0.8,
        maxWindowRatio: 2.5,
        maxNarrationCharRatio: 8,
      },
    });
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
    expect(plan.matchRate).toEqual({
      scope: "v1-corpus",
      matchedRows: 1,
      rows: 1,
      refusedRows: 0,
      value: 1,
    });
  });

  it("matches a Sanadset matn against a stored child that also carries the isnad", async () => {
    // The v1 corpus stores the API edition's whole narration; a matn-only
    // comparison reads 0.34 and calls the report new. The matn must be found
    // inside the stored narration instead.
    const plan = await planFor([sourceRow()], [child("v1-child", fullNarration(MATN_A))]);
    expect(plan.groups[0]?.target).toMatchObject({
      kind: "existing",
      childId: "v1-child",
      how: "containment",
    });
    expect(plan.children.matched).toBe(1);
    expect(plan.children.created).toHaveLength(0);
    expect(plan.matchRate).toEqual({
      scope: "v1-corpus",
      matchedRows: 1,
      rows: 1,
      refusedRows: 0,
      value: 1,
    });
  });

  it("quarantines a matn that only occurs as a fragment of a much longer narration", async () => {
    // The stored narration is an otherwise unrelated text that happens to quote
    // the matn: containment is total, but the relation is a quotation, not the
    // report. No chain and no child may be planned for the group.
    const filler =
      "قال حدثنا أخبرنا عن ابن عمر أن رسول الله صلى الله عليه وسلم ذكر حديثا طويلا في مجلس " +
      "من مجالس العلم والذكر ثم سأله رجل عن معنى ذلك فبينه له بيانا شافيا ثم انصرف القوم";
    const narration = fullNarration(`${MATN_A} ${filler} ${filler} ${filler} ${filler} ${filler}`);
    const plan = await planFor([sourceRow()], [child("long-narration", narration)]);
    const target = plan.groups[0]?.target;
    expect(target).toMatchObject({
      kind: "fragmentary",
      childId: "long-narration",
      how: "containment",
    });
    expect(target?.kind === "fragmentary" ? target.reason : "").toContain(
      "the stored narration is",
    );
    expect(plan.children.fragmentary).toBe(1);
    expect(plan.children.matched).toBe(0);
    expect(plan.children.created).toHaveLength(0);
    expect(plan.chains).toHaveLength(0);
    expect(plan.quarantine.byRule).toEqual({ fragmentary_containment: 1 });
    expect(plan.quarantine.rows[0]?.detail).toContain("long-narration");
    expect(plan.quarantine.rows[0]?.detail).toContain("no target is claimed");
    // D4: the refused row never had a target, so it cannot be a match-rate row.
    expect(plan.matchRate).toEqual({
      scope: "v1-corpus",
      matchedRows: 0,
      rows: 0,
      refusedRows: 1,
      value: 0,
    });
  });

  it("quarantines a group whose candidate search hits its cap", async () => {
    // Every stored narration carries the same rare token, so the candidate union
    // is capped before the true target can be guaranteed present: bounded recall
    // must quarantine, not pick whatever survived the cap.
    const rare = "زززززز";
    const children = Array.from({ length: 1100 }, (_, index) =>
      child(`child-${index}`, fullNarration(`${MATN_A} ${rare} ${index}`)),
    );
    const plan = await planFor([sourceRow({ matn: `${MATN_A} ${rare}` })], children);
    expect(plan.groups[0]?.target).toEqual({ kind: "truncated", candidates: 1024, cap: 1024 });
    expect(plan.children.truncatedSearches).toBe(1);
    expect(plan.children.created).toHaveLength(0);
    expect(plan.chains).toHaveLength(0);
    expect(plan.quarantine.byRule).toEqual({ truncated_candidate_search: 1 });
    // A bounded search is a refused target: it is not a row that could have matched.
    expect(plan.matchRate).toEqual({
      scope: "v1-corpus",
      matchedRows: 0,
      rows: 0,
      refusedRows: 1,
      value: 0,
    });
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
    expect(plan.matchRate).toEqual({
      scope: "v1-corpus",
      matchedRows: 0,
      rows: 0,
      refusedRows: 1,
      value: 0,
    });
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

  it("keys new children by matn content while keeping the cascade's group order", async () => {
    const rows = [
      sourceRow({ rowIndex: 0, hadithNumber: "1" }),
      sourceRow({ rowIndex: 1, hadithNumber: "2", matn: MATN_B }),
      sourceRow({ rowIndex: 2, hadithNumber: "3", matn: MATN_C }),
    ];
    const plan = await planFor(rows, [child("child-b", MATN_B)]);
    expect(plan.groups.map((group) => group.groupId)).toEqual([0, 1, 2]);
    const created = plan.children.created;
    // The middle group matched a stored child; the others are new, in group order.
    expect(created.map((entry) => entry.groupId)).toEqual([0, 2]);
    // The write key is the content digest, not the position: a reorder cannot
    // reuse one narration's row for another's derived fields.
    expect(created.every((entry) => /^[0-9a-f]{64}$/.test(entry.matnKey))).toBe(true);
    expect(new Set(created.map((entry) => entry.matnKey)).size).toBe(created.length);
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
