/**
 * The S2 pilot plan: what one collection's slice writes, computed before anything
 * is written.
 *
 * The plan is the dry run's output and the write path's input, so the two cannot
 * disagree about what will happen. It applies the S1 rules unchanged — the
 * pre-registered thresholds, the book-scoped group book, the quarantine rules — and
 * adds the one decision the study left to S2: which stored child of the same
 * collection each matn group attaches to, or that it attaches to a new child. A
 * group whose target is ambiguous is quarantined whole, so the ambiguity is visible
 * in the report, not in a chain on the wrong narration.
 *
 * Nothing here reads the environment, the archive or the store: the caller supplies
 * the prepared slice and the collection's stored children, which is what lets the
 * dry run, the gated suite and the real run share one definition of the plan.
 */

import { runMatnCascade } from "./sanadset-cascade";
import {
  S1_AMBIGUITY_MARGIN,
  S1_AUTO_MATCH_THRESHOLD,
  type MatnDecision,
} from "./sanadset-cascade-types";
import { planNarrators, type NarratorPlanResult } from "./sanadset-ingest-catalogue";
import {
  createChildMatchIndex,
  type ExistingChildRow,
  type MatnTarget,
} from "./sanadset-ingest-match";
import {
  SLICE_BOOKS,
  type PreparedRow,
  type PrepareStats,
  type QuarantinedRow,
  type SliceBook,
} from "./sanadset-prepare";

/** The one collection this pilot ingests; a full run grows this list, not the code path. */
export const PILOT_COLLECTIONS = ["bukhari"] as const;
export type PilotCollection = (typeof PILOT_COLLECTIONS)[number];

/**
 * The slice's own book value and the corpus collection key it reconciles against.
 * `key` names the pilot's slice; `collection` is the store's key for those children,
 * which a fork may name differently and a test isolates per run.
 */
export type PilotScope = {
  readonly key: PilotCollection;
  readonly book: SliceBook;
  readonly collection: string;
};

export const PILOT_SCOPE: PilotScope = {
  key: "bukhari",
  book: SLICE_BOOKS[0],
  collection: "bukhari",
};

/** Resolve `--collection`; the pilot's scope is one collection and names it on refusal. */
export function resolvePilotCollection(raw: string): PilotScope {
  if ((PILOT_COLLECTIONS as readonly string[]).includes(raw)) return PILOT_SCOPE;
  throw new Error(
    `--collection must be one of ${PILOT_COLLECTIONS.join(", ")}, got "${raw}" — ` +
      "the pilot ingests one collection; a full run is a separate dispatch",
  );
}

/** One matn group and where its chains will land. */
export type GroupPlan = {
  readonly groupId: number;
  readonly representativeRowIndex: number;
  readonly hadithNumber: string;
  readonly rawMatn: string;
  readonly foldedMatn: string;
  /** Prepared rows whose chain attaches to this group's target, in source order. */
  readonly memberRows: readonly number[];
  readonly target: MatnTarget;
};

/** A child this run creates: one matn group, under the pilot's parent for the collection. */
export type NewChildPlan = {
  readonly ordinal: number;
  readonly groupId: number;
  readonly textRaw: string;
  readonly hadithNumber: string;
  readonly representativeRowIndex: number;
};

/** One chain write: a source row's ordered folded names, attached to its group's child. */
export type ChainPlan = {
  readonly rowIndex: number;
  readonly groupId: number;
  readonly foldedChain: readonly string[];
  readonly sourceRef: string;
};

export type IngestPlan = {
  readonly scope: PilotScope;
  readonly slice: { readonly rows: number; readonly noSanad: number; readonly prepared: number };
  readonly groups: readonly GroupPlan[];
  readonly children: {
    /** Stored children the corpus read returned, before the collection filter. */
    readonly read: number;
    /** Stored children of this collection the matcher compared against. */
    readonly compared: number;
    readonly matched: number;
    readonly ambiguous: number;
    readonly created: readonly NewChildPlan[];
    /** Groups whose trigram search hit the candidate cap: bounded recall, reported. */
    readonly truncatedSearches: number;
  };
  readonly chains: readonly ChainPlan[];
  readonly narrators: NarratorPlanResult;
  readonly quarantine: {
    readonly total: number;
    readonly byRule: Readonly<Record<string, number>>;
    readonly rows: readonly QuarantinedRow[];
  };
  readonly matchRate: {
    readonly scope: "v1-corpus";
    readonly matchedRows: number;
    readonly rows: number;
    readonly value: number;
  };
};

export type BuildPlanOptions = {
  readonly scope: PilotScope;
  /** The prepared slice, both books; the builder filters to the scope. */
  readonly rows: readonly PreparedRow[];
  /** Prepare-stage quarantines, both books; the builder filters to the scope. */
  readonly sourceQuarantined: readonly QuarantinedRow[];
  readonly stats: PrepareStats;
  readonly children: readonly ExistingChildRow[];
  /** True when the corpus read hit its limit: the plan refuses rather than guess. */
  readonly childrenCapHit: boolean;
  readonly autoThreshold?: number;
  readonly ambiguityMargin?: number;
};

/** The source row's address in the archive: the chain's natural key, stable across runs. */
export function chainSourceRef(rowIndex: number): string {
  return `sanadset:row:${rowIndex}`;
}

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
  const written: PreparedRow[] = [];
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
      memberRows: [],
      target: matchIndex.match(representative),
    });
  }
  const targetByGroup = new Map(groups.map((group) => [group.groupId, group.target]));

  // A group the matcher refused to place is quarantined whole: every row's chain is
  // held back, and the reason names the two children that tied.
  const ambiguousRows: QuarantinedRow[] = [];
  const writtenRows = written.filter((row) => {
    const groupId = decisions.get(row.rowIndex)?.groupId;
    const target =
      groupId === null || groupId === undefined ? undefined : targetByGroup.get(groupId);
    if (target === undefined || target.kind !== "ambiguous") return true;
    ambiguousRows.push({
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

  // The ordinal is the group's cascade position, not its position among new children:
  // a group that later matches a stored child must not shift later children's ordinals,
  // which are the store's upsert key (parent, ordinal).
  const created: NewChildPlan[] = [];
  for (const [ordinal, group] of plannedGroups.entries()) {
    if (group.target.kind !== "new" || group.memberRows.length === 0) continue;
    created.push({
      ordinal,
      groupId: group.groupId,
      textRaw: group.rawMatn,
      hadithNumber: group.hadithNumber,
      representativeRowIndex: group.representativeRowIndex,
    });
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
  const quarantineRows = [...scopedSource, ...cascade.quarantined, ...ambiguousRows];
  const existingTargetGroups = plannedGroups.filter(
    (group) => group.target.kind === "existing" && group.memberRows.length > 0,
  );
  const matchedRowIndexes = new Set(existingTargetGroups.flatMap((group) => group.memberRows));
  const bookStats = options.stats.byBook[scope.book];
  const matchRateRows = written.length;
  return {
    scope,
    slice: { rows: bookStats.rows, noSanad: bookStats.noSanad, prepared: scoped.length },
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
