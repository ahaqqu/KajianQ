/**
 * The S2 pilot plan: what one collection's slice writes, computed before anything
 * is written. It is the dry run's output and the write path's input, so a run and
 * the plan the operator approved cannot disagree. It applies the S1 rules and adds
 * one decision: which stored child of the same collection a matn group attaches
 * to, or that it attaches to a new child; a group whose target is ambiguous or
 * whose candidate search was capped is quarantined whole. It reads neither the
 * environment nor the store — the caller supplies the slice and the stored
 * children — so the dry run and the gated suite share one definition of the plan.
 */

import { runMatnCascade } from "./sanadset-cascade";
import {
  S1_AMBIGUITY_MARGIN,
  S1_AUTO_MATCH_THRESHOLD,
  type MatnDecision,
} from "./sanadset-cascade-types";
import { planNarrators } from "./sanadset-ingest-catalogue";
import { createChildMatchIndex } from "./sanadset-ingest-match";
import {
  chainSourceRef,
  type BuildPlanOptions,
  type ChainPlan,
  type GroupPlan,
  type IngestPlan,
  type NewChildPlan,
  type QuarantinedRow,
} from "./sanadset-ingest-plan-types";

export * from "./sanadset-ingest-plan-types";

function countByRule(rows: readonly QuarantinedRow[]): Record<string, number> {
  const byRule: Record<string, number> = {};
  for (const row of rows) byRule[row.rule] = (byRule[row.rule] ?? 0) + 1;
  return byRule;
}

export async function buildSanadsetPlan(options: BuildPlanOptions): Promise<IngestPlan> {
  const { scope } = options;
  const scoped = options.rows.filter((row) => row.book === scope.book);
  if (scoped.length === 0) {
    throw new Error(
      `no prepared rows for "${scope.book}" — the archive is not the slice this pilot ingests`,
    );
  }
  if (options.childrenCapHit) {
    throw new Error(
      "the corpus read hit its child limit, so the matn target set would be truncated; " +
        "raise the child read limit and run again — a truncated set can create a duplicate child",
    );
  }

  const cascade = await runMatnCascade({ rows: scoped, bookScope: "book" });
  const decisions = new Map<number, MatnDecision>();
  for (const decision of cascade.decisions) decisions.set(decision.rowIndex, decision);
  const rowByIndex = new Map(scoped.map((row) => [row.rowIndex, row]));
  const written: typeof scoped = [];
  for (const row of scoped) {
    const decision = decisions.get(row.rowIndex);
    if (decision === undefined)
      throw new Error(`matn cascade: no decision for row ${row.rowIndex}`);
    if (decision.kind !== "quarantined") written.push(row);
  }

  const matchIndex = createChildMatchIndex(options.children, {
    collection: scope.collection,
    autoThreshold: options.autoThreshold ?? S1_AUTO_MATCH_THRESHOLD,
    ambiguityMargin: options.ambiguityMargin ?? S1_AMBIGUITY_MARGIN,
  });
  const groups: GroupPlan[] = [];
  for (const group of cascade.groups) {
    const representative = rowByIndex.get(group.representativeRowIndex);
    if (representative === undefined) continue;
    groups.push({
      groupId: group.groupId,
      representativeRowIndex: group.representativeRowIndex,
      hadithNumber: representative.hadithNumber,
      rawMatn: representative.rawMatn,
      foldedMatn: representative.normalizedMatn,
      matnKey: representative.matnKey,
      memberRows: [],
      target: matchIndex.match(representative),
    });
  }
  const targetByGroup = new Map(groups.map((group) => [group.groupId, group.target]));

  // A group the matcher refused to place is quarantined whole: every row's chain is
  // held back, and the reason names the two children that tied (or the cap that cut
  // the search short) so a reader can tell which refusal held it.
  const refusedRows: QuarantinedRow[] = [];
  const writtenRows = written.filter((row) => {
    const groupId = decisions.get(row.rowIndex)?.groupId;
    const target =
      groupId === null || groupId === undefined ? undefined : targetByGroup.get(groupId);
    if (target === undefined) return true;
    if (target.kind === "ambiguous") {
      refusedRows.push({
        rowIndex: row.rowIndex,
        book: row.book,
        hadithNumber: row.hadithNumber,
        rule: "ambiguous_best_match",
        detail:
          `matn group ${groupId} scored ${target.score.toFixed(3)} against two children ` +
          `(${target.candidates.join(", ")}); no arbitrary target is chosen`,
        sanadLength: null,
      });
      return false;
    }
    if (target.kind === "truncated") {
      refusedRows.push({
        rowIndex: row.rowIndex,
        book: row.book,
        hadithNumber: row.hadithNumber,
        rule: "truncated_candidate_search",
        detail:
          `matn group ${groupId} hit the ${target.cap}-candidate search cap; the target set ` +
          "was bounded, so no target is claimed",
        sanadLength: null,
      });
      return false;
    }
    return true;
  });

  const membersByGroup = new Map<number, number[]>();
  for (const row of writtenRows) {
    const groupId = decisions.get(row.rowIndex)?.groupId;
    if (groupId === null || groupId === undefined) continue;
    const members = membersByGroup.get(groupId) ?? [];
    members.push(row.rowIndex);
    membersByGroup.set(groupId, members);
  }
  const plannedGroups = groups.map((group) => ({
    ...group,
    memberRows: membersByGroup.get(group.groupId) ?? [],
  }));

  // Children are keyed by the digest of their immutable raw text, never by their
  // cascade position: a group that later matches a stored child, or a reordered
  // plan, must not point a stored row at another narration's derived fields.
  const created: NewChildPlan[] = [];
  for (const group of plannedGroups) {
    if (group.target.kind !== "new" || group.memberRows.length === 0) continue;
    created.push({
      matnKey: group.matnKey,
      groupId: group.groupId,
      textRaw: group.rawMatn,
      hadithNumber: group.hadithNumber,
      representativeRowIndex: group.representativeRowIndex,
    });
  }
  const seenKeys = new Map<string, number>();
  for (const child of created) {
    const previous = seenKeys.get(child.matnKey);
    if (previous !== undefined) {
      throw new Error(
        `matn groups ${previous} and ${child.groupId} carry the same raw matn; ` +
          "one child cannot be keyed by two groups",
      );
    }
    seenKeys.set(child.matnKey, child.groupId);
  }

  const chains: ChainPlan[] = writtenRows.map((row) => {
    const groupId = decisions.get(row.rowIndex)?.groupId;
    if (groupId === null || groupId === undefined) {
      throw new Error(`matn cascade: written row ${row.rowIndex} has no group`);
    }
    return {
      rowIndex: row.rowIndex,
      groupId,
      foldedChain: row.chain,
      sourceRef: chainSourceRef(row.rowIndex),
    };
  });

  const scopedSource = options.sourceQuarantined.filter((row) => row.book === scope.book);
  const quarantineRows = [...scopedSource, ...cascade.quarantined, ...refusedRows];
  const existingTargetGroups = plannedGroups.filter(
    (group) => group.target.kind === "existing" && group.memberRows.length > 0,
  );
  const matchedRowIndexes = new Set(existingTargetGroups.flatMap((group) => group.memberRows));
  const bookStats = options.stats.byBook[scope.book];
  const matchRateRows = written.length;
  return {
    scope,
    slice: {
      rows: bookStats.rows,
      noSanad: bookStats.noSanad,
      prepared: scoped.length,
      quarantined: scopedSource.length,
      quarantinedByRule: countByRule(scopedSource),
    },
    groups: plannedGroups,
    children: {
      read: options.children.length,
      compared: matchIndex.collectionChildren,
      matched: existingTargetGroups.length,
      ambiguous: plannedGroups.filter((group) => group.target.kind === "ambiguous").length,
      created,
      truncatedSearches: matchIndex.truncatedSearches(),
    },
    chains,
    narrators: planNarrators(writtenRows),
    quarantine: {
      total: quarantineRows.length,
      byRule: countByRule(quarantineRows),
      rows: quarantineRows,
    },
    matchRate: {
      scope: "v1-corpus",
      matchedRows: matchedRowIndexes.size,
      rows: matchRateRows,
      value: matchRateRows === 0 ? 0 : matchedRowIndexes.size / matchRateRows,
    },
  };
}
