/**
 * The pilot's scope and the shapes its plan carries.
 *
 * Split from the plan builder so the builder stays one computation: these types
 * are the contract the dry run, the write path and the report share, and the
 * scope is pinned here as a literal pair rather than derived from an array index.
 */

import type { NarratorPlanResult } from "./sanadset-ingest-catalogue";
import type { ExistingChildRow, MatnTarget } from "./sanadset-ingest-match";
import type { PreparedRow, PrepareStats, QuarantinedRow, SliceBook } from "./sanadset-prepare";

export type { PreparedRow, QuarantinedRow } from "./sanadset-prepare";

/** The one collection this pilot ingests; a full run grows this list, not the code path. */
export const PILOT_COLLECTIONS = ["bukhari"] as const;

/**
 * The slice's own book and the corpus collection key it reconciles against: `key`
 * names the pilot's slice, `collection` the store's key for those children.
 */
export type PilotScope = {
  readonly key: (typeof PILOT_COLLECTIONS)[number];
  readonly book: SliceBook;
  readonly collection: string;
};

/**
 * The exact Arabic `Book` value of the pilot's slice, written out rather than read
 * from `SLICE_BOOKS[0]`: an index would move with the array, silently filtering
 * another book's rows against the `bukhari` collection. The type makes a literal
 * outside the slice's book set a compile error.
 */
export const PILOT_BOOK: SliceBook = "صحيح البخاري";

export const PILOT_SCOPE: PilotScope = {
  key: "bukhari",
  book: PILOT_BOOK,
  collection: "bukhari",
};

/** Resolve `--collection`; the pilot's scope is one collection and names it on refusal. */
export function resolvePilotCollection(raw: string): PilotScope {
  if (raw === PILOT_SCOPE.key) return PILOT_SCOPE;
  throw new Error(
    `--collection must be one of ${PILOT_COLLECTIONS.join(", ")}, got "${raw}" — ` +
      "the pilot ingests one collection; a full run is a separate dispatch",
  );
}

/** The prefix of every chain address this pilot owns; reconciliation deletes only these. */
export const PILOT_CHAIN_SOURCE_PREFIX = "sanadset:row:";

/** The source row's address in the archive: the chain's natural key, stable across runs. */
export function chainSourceRef(rowIndex: number): string {
  return `${PILOT_CHAIN_SOURCE_PREFIX}${rowIndex}`;
}

/** One matn group and where its chains will land. */
export type GroupPlan = {
  readonly groupId: number;
  readonly representativeRowIndex: number;
  readonly hadithNumber: string;
  readonly rawMatn: string;
  readonly foldedMatn: string;
  /** Content identity of {@link rawMatn}: the child write key, never the ordinal. */
  readonly matnKey: string;
  /** Prepared rows whose chain attaches to this group's target, in source order. */
  readonly memberRows: readonly number[];
  readonly target: MatnTarget;
};

export type NewChildPlan = {
  readonly matnKey: string;
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
  readonly slice: {
    readonly rows: number;
    readonly noSanad: number;
    readonly prepared: number;
    /** Quarantined before the matn cascade: the prepare stage's own rules. */
    readonly quarantined: number;
    readonly quarantinedByRule: Readonly<Record<string, number>>;
  };
  readonly groups: readonly GroupPlan[];
  readonly children: {
    /** Stored children the corpus read returned, before the collection filter. */
    readonly read: number;
    /** Stored children of this collection the matcher compared against. */
    readonly compared: number;
    readonly matched: number;
    readonly ambiguous: number;
    readonly created: readonly NewChildPlan[];
    /** Groups whose candidate search hit its cap: bounded recall, quarantined. */
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
  readonly sourceQuarantined: readonly QuarantinedRow[];
  readonly stats: PrepareStats;
  readonly children: readonly ExistingChildRow[];
  /** True when the corpus read hit its limit: the plan refuses rather than guess. */
  readonly childrenCapHit: boolean;
  readonly autoThreshold?: number;
  readonly ambiguityMargin?: number;
};
