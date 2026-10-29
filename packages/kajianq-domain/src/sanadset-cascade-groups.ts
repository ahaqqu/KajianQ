/**
 * The group book the cascade decides against: one canonical group per distinct
 * matn, the exact and folded lookup maps that short-circuit the first two stages,
 * and the MinHash index that proposes trigram candidates.
 *
 * Groups never merge with each other. A row joins at most one group and a group is
 * never split, so a decision has no retraction path and a replay of the same input
 * order reproduces the same book.
 */

import { addToLshIndex, searchLshIndex, type LshIndex } from "./sanadset-blocking";
import type { MatnGroup } from "./sanadset-cascade-types";
import type { PreparedRow } from "./sanadset-prepare";

export type MutableGroup = { groupId: number; representativeRowIndex: number; memberCount: number };
export type IndexedMember = { readonly rowIndex: number; readonly groupId: number };

export type LshSearch = { readonly values: IndexedMember[]; readonly truncated: boolean };

export type GroupBook = {
  readonly groups: MutableGroup[];
  readonly exact: Map<string, number>;
  readonly folded: Map<string, number>;
  groupOf(groupId: number): MutableGroup;
  groupIdForExactMatn(rawMatn: string): number | undefined;
  groupIdForFoldedMatn(normalizedMatn: string): number | undefined;
  start(row: PreparedRow): number;
  join(row: PreparedRow, groupId: number): void;
  search(row: PreparedRow): LshSearch;
  snapshot(): MatnGroup[];
};

export function createGroupBook(): GroupBook {
  const groups: MutableGroup[] = [];
  const exact = new Map<string, number>();
  const folded = new Map<string, number>();
  const index: LshIndex<IndexedMember> = new Map();

  const remember = (row: PreparedRow, groupId: number): void => {
    if (!exact.has(row.rawMatn)) exact.set(row.rawMatn, groupId);
    if (!folded.has(row.normalizedMatn)) folded.set(row.normalizedMatn, groupId);
  };

  const insert = (row: PreparedRow, groupId: number): void => {
    addToLshIndex(index, row.bandKeys, { rowIndex: row.rowIndex, groupId });
    remember(row, groupId);
  };

  return {
    groups,
    exact,
    folded,
    groupOf(groupId: number): MutableGroup {
      const group = groups[groupId];
      if (group === undefined) throw new Error(`matn cascade: unknown group ${groupId}`);
      return group;
    },
    groupIdForExactMatn(rawMatn: string): number | undefined {
      return exact.get(rawMatn);
    },
    groupIdForFoldedMatn(normalizedMatn: string): number | undefined {
      return folded.get(normalizedMatn);
    },
    start(row: PreparedRow): number {
      const groupId = groups.length;
      groups.push({ groupId, representativeRowIndex: row.rowIndex, memberCount: 1 });
      insert(row, groupId);
      return groupId;
    },
    join(row: PreparedRow, groupId: number): void {
      const group = this.groupOf(groupId);
      group.memberCount += 1;
      insert(row, groupId);
    },
    search(row: PreparedRow): LshSearch {
      return searchLshIndex(index, row.bandKeys);
    },
    snapshot(): MatnGroup[] {
      return groups.map((group) => ({
        groupId: group.groupId,
        representativeRowIndex: group.representativeRowIndex,
        memberCount: group.memberCount,
      }));
    },
  };
}
