/**
 * The book scope's effect, measured rather than asserted.
 *
 * A `book`-scoped group book never joins two works' matns, so the joins it prevents are
 * invisible in its own decisions. This module replays the same cascade against an
 * unscoped book and counts them, so the report's number is a property of the run's data
 * and not a constant someone typed. The replay passes no adjudicator, so it issues no
 * model call and costs nothing but the deterministic pass.
 */

import { runMatnCascade } from "./sanadset-cascade";
import type { CascadeResult, CrossBookJoins } from "./sanadset-cascade-types";
import type { PreparedRow } from "./sanadset-prepare";

const DETERMINISTIC_JOINS = new Set(["exact", "folded", "trigram"]);

type CrossBookTally = { total: number; exact: number; folded: number; trigram: number };

/** Count the joins in `result` that merged a row into a group represented by another book. */
export function countCrossBookJoins(
  rows: readonly PreparedRow[],
  result: CascadeResult,
): CrossBookTally {
  const bookByRow = new Map<number, string>();
  for (const row of rows) bookByRow.set(row.rowIndex, row.book);
  const representativeByGroup = new Map<number, number>();
  for (const group of result.groups)
    representativeByGroup.set(group.groupId, group.representativeRowIndex);
  const tally: CrossBookTally = { total: 0, exact: 0, folded: 0, trigram: 0 };
  for (const decision of result.decisions) {
    if (!DETERMINISTIC_JOINS.has(decision.kind)) continue;
    if (decision.groupId === null) continue;
    const representative = representativeByGroup.get(decision.groupId);
    if (representative === undefined) continue;
    if (bookByRow.get(representative) === bookByRow.get(decision.rowIndex)) continue;
    tally.total += 1;
    if (decision.kind === "exact") tally.exact += 1;
    else if (decision.kind === "folded") tally.folded += 1;
    else tally.trigram += 1;
  }
  return tally;
}

/**
 * Measure what the book scope prevents: replay the same cascade against an unscoped book
 * and count the joins it would have made across books. The replay issues no model call
 * (no adjudicator is passed), so it costs nothing but the deterministic pass.
 */
export async function measureCrossBookJoins(
  rows: readonly PreparedRow[],
  scoped: CascadeResult,
): Promise<CrossBookJoins> {
  const unscoped = await runMatnCascade({ rows, bookScope: "global" });
  const tally = countCrossBookJoins(rows, unscoped);
  return {
    joinsInThisRun: countCrossBookJoins(rows, scoped).total,
    unscopedTotal: tally.total,
    unscopedExact: tally.exact,
    unscopedFolded: tally.folded,
    unscopedTrigram: tally.trigram,
    scopedChildren: scoped.groups.length,
    unscopedChildren: unscoped.groups.length,
  };
}
