/**
 * The group book the cascade decides against: one canonical group per distinct
 * matn, the exact and folded lookup maps that short-circuit the first two stages,
 * and the MinHash index that proposes trigram candidates.
 *
 * Two books exist and both are named by the caller. The study's book is **per book**:
 * a Bukhari matn and a Muslim matn are never the same child, whatever their texts share,
 * because a child is something an isnad attaches to inside one work. The `global` scope
 * reproduces the unscoped book and exists so the study can measure what the scope
 * prevents — it is a diagnostic, not a second definition of the cascade.
 *
 * Groups never merge with each other. A row joins at most one group and a group is
 * never split, so a decision has no retraction path and a replay of the same input
 * order reproduces the same book.
 */

import { addToLshIndex, searchLshIndex, type LshIndex } from "./sanadset-blocking";
import type { CascadeBookScope, MatnGroup } from "./sanadset-cascade-types";
import type { PreparedRow } from "./sanadset-prepare";

export type MutableGroup = { groupId: number; representativeRowIndex: number; memberCount: number };
export type IndexedMember = { readonly rowIndex: number; readonly groupId: number };

export type LshSearch = { readonly values: IndexedMember[]; readonly truncated: boolean };

export type GroupBook = {
  readonly scope: CascadeBookScope;
  readonly groups: MutableGroup[];
  readonly exact: Map<string, number>;
  readonly folded: Map<string, number>;
  groupOf(groupId: number): MutableGroup;
  groupIdForExactMatn(book: string, rawMatn: string): number | undefined;
  groupIdForFoldedMatn(book: string, normalizedMatn: string): number | undefined;
  start(row: PreparedRow): number;
  join(row: PreparedRow, groupId: number): void;
  search(row: PreparedRow): LshSearch;
  snapshot(): MatnGroup[];
};

/** The map key of a matn under a scope: the book is part of the identity only when scoped. */
function keyOf(scope: CascadeBookScope, book: string, text: string): string {
  return scope === "book" ? `${book}\u0000${text}` : text;
}

export function createGroupBook(scope: CascadeBookScope = "book"): GroupBook {
  const groups: MutableGroup[] = [];
  const exact = new Map<string, number>();
  const folded = new Map<string, number>();
  // One index per book: under `book` scope a cross-book candidate can never be proposed
  // (nor truncate a search), and under `global` scope every row shares one index.
  const indexes = new Map<string, LshIndex<IndexedMember>>();

  const indexFor = (scopeKey: string): LshIndex<IndexedMember> => {
    const existing = indexes.get(scopeKey);
    if (existing !== undefined) return existing;
    const created: LshIndex<IndexedMember> = new Map();
    indexes.set(scopeKey, created);
    return created;
  };
  const scopeKey = (book: string): string => (scope === "book" ? book : "");

  const remember = (row: PreparedRow, groupId: number): void => {
    const exactKey = keyOf(scope, row.book, row.rawMatn);
    if (!exact.has(exactKey)) exact.set(exactKey, groupId);
    const foldedKey = keyOf(scope, row.book, row.normalizedMatn);
    if (!folded.has(foldedKey)) folded.set(foldedKey, groupId);
  };

  const insert = (row: PreparedRow, groupId: number): void => {
    addToLshIndex(indexFor(scopeKey(row.book)), row.bandKeys, {
      rowIndex: row.rowIndex,
      groupId,
    });
    remember(row, groupId);
  };

  return {
    scope,
    groups,
    exact,
    folded,
    groupOf(groupId: number): MutableGroup {
      const group = groups[groupId];
      if (group === undefined) throw new Error(`matn cascade: unknown group ${groupId}`);
      return group;
    },
    groupIdForExactMatn(book: string, rawMatn: string): number | undefined {
      return exact.get(keyOf(scope, book, rawMatn));
    },
    groupIdForFoldedMatn(book: string, normalizedMatn: string): number | undefined {
      return folded.get(keyOf(scope, book, normalizedMatn));
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
      return searchLshIndex(indexFor(scopeKey(row.book)), row.bandKeys);
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
