import type { StoreError } from "@app/rag-core";
import type { Effect } from "effect";
import type { NarratorRecord } from "./rag-store-narrator-seam";

/**
 * Write half of the `RagStore` narrator seam: the two rows the v2 ingestion
 * produces — a resolved narrator and the ordered chain attached to a child
 * chunk — and the rules that make writing them twice harmless.
 *
 * Both writes are **upserts on a natural key, never on a name**:
 *
 * - A narrator is keyed by the caller's opaque `identityKey`. The store never
 *   interprets it, so identity stays domain logic; two narrators may share a
 *   canonical name and stay two rows, and a repeated write of one key returns
 *   the same row with the union of the variants it has been given.
 * - A chain is keyed by `(collection, sourceRef)`. The address is the source's
 *   own address for the chain, so a re-run upserts the row it already wrote and
 *   a later reconciliation that refines which child the chain transmits moves
 *   the row instead of leaving a duplicate on the old child.
 *
 * The natural key must therefore be present: a chain without a non-blank source
 * address cannot be upserted, and the write refuses rather than inserting a row
 * every re-run would duplicate. `grade`/`grader` travel together as in the read
 * seam, and the engine validates no grade vocabulary — the domain pack's schema
 * does, and the adapter reports its rejection as a `constraint` error.
 */

/** One narrator to persist. `identityKey` is the upsert target and is opaque here. */
export type NarratorUpsert = {
  /** Caller-supplied identity key: the row's write identity, never a name. */
  identityKey: string;
  /** The ingested canonical spelling (Arabic); non-blank. */
  canonicalNameAr: string;
  /** Every other recorded spelling; blanks are not spellings and are refused. */
  nameVariants?: readonly string[];
  kunya?: string | null;
  laqab?: string | null;
  deathYear?: number | null;
  tabaqa?: string | null;
  reliabilityByCritic?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
};

/** One chain to persist: an ordered narrator sequence attached to a child chunk. */
export type NarratorChainInsert = {
  childId: string;
  collection: string;
  narratorIds: readonly string[];
  /** Per-chain classification; absent is an ungraded chain (the pilot's case). */
  grade?: string | null;
  /** The grader `grade` belongs to; present exactly when `grade` is. */
  grader?: string | null;
  /**
   * The source's own address for this chain: its natural key when present. `null`
   * records a chain the source does not address (a curated addition), which no
   * re-run can upsert; a blank string is refused.
   */
  sourceRef: string | null;
};

/** The write methods; `RagStoreNarrators` extends this, so consumers see one seam. */
export interface RagStoreNarratorWrites {
  /**
   * Upsert one narrator by `identityKey` and return the stored row.
   *
   * A repeated write with the same key updates the row in place — the variants
   * are the union of what it already carried and what this call supplies, and
   * the returned id never changes — so a re-run cannot create a second row for
   * one identity. Two different keys always write two rows, whatever names they
   * share.
   *
   * A blank key, a blank canonical name, a blank variant, a non-positive death
   * year or a blank critic key fails as a `constraint` StoreError before any
   * row is written: those are not addressable identities or spellings.
   */
  upsertNarrator(input: NarratorUpsert): Effect.Effect<NarratorRecord, StoreError>;

  /**
   * Upsert a batch of chains and return their ids in input order.
   *
   * Idempotent by `(collection, sourceRef)`: writing the same source address
   * again updates the row it wrote before (its child, its ordered narrator
   * sequence, its grade pair) instead of appending a second chain. A `null`
   * address writes a chain no re-run can key on. A row whose `sourceRef` is
   * blank, whose `narratorIds` is empty or carries a blank element, whose `collection`/`childId` is blank, whose grade and grader are
   * not present together, or whose grader is blank, fails as a `constraint`
   * StoreError for the whole batch: a half-written chain set would report a
   * transmission the corpus does not hold.
   *
   * The batch is inserted in input order; `narrator_chains.seq` (the read's
   * neutral order) is allocated in that order, so one ingestion transaction
   * supplies a child's chains in the sequence the source states.
   */
  insertNarratorChains(
    rows: readonly NarratorChainInsert[],
  ): Effect.Effect<readonly string[], StoreError>;
}

/**
 * Why a narrator write must be refused before it reaches the database, or null
 * when it is writable. One predicate, called by the Postgres adapter and the
 * in-memory double, so the double cannot accept a row the real store rejects —
 * the divergence is checked in neither place twice.
 */
export function narratorWriteProblem(input: NarratorUpsert): string | null {
  if (input.identityKey.trim() === "") return "narrator write has a blank identity key";
  if (input.canonicalNameAr.trim() === "") return "narrator write has a blank canonical name";
  for (const variant of input.nameVariants ?? []) {
    if (variant.trim() === "") {
      return `narrator '${input.identityKey}' carries a blank name variant`;
    }
  }
  if (input.deathYear !== null && input.deathYear !== undefined) {
    if (!Number.isInteger(input.deathYear) || input.deathYear <= 0) {
      return `narrator '${input.identityKey}' has a non-positive death year`;
    }
  }
  for (const critic of Object.keys(input.reliabilityByCritic ?? {})) {
    if (critic.trim() === "") return `narrator '${input.identityKey}' has a blank critic key`;
  }
  return null;
}

/**
 * Why a chain write must be refused before it reaches the database, or null
 * when it is writable — the same one-predicate rule as
 * {@link narratorWriteProblem}, mirrored by the memory double.
 */
export function chainWriteProblem(row: NarratorChainInsert): string | null {
  const address = row.sourceRef ?? "(no address)";
  if (row.childId.trim() === "") return "chain write has a blank child id";
  if (row.collection.trim() === "") return "chain write has a blank collection";
  if (row.sourceRef !== null && row.sourceRef.trim() === "") {
    return "chain write has a blank source address — an addressed chain cannot be upserted";
  }
  if (row.narratorIds.length === 0) return `chain '${address}' has no narrator`;
  for (const id of row.narratorIds) {
    if (id.trim() === "") return `chain '${address}' carries a blank narrator id`;
  }
  const grade = row.grade ?? null;
  const grader = row.grader ?? null;
  if ((grade === null) !== (grader === null)) {
    return grade === null
      ? `chain '${address}' carries a grader without a grade`
      : `chain '${address}' carries a grade without a grader`;
  }
  if (grader !== null && grader.trim() === "") {
    return `chain '${address}' carries a blank grader`;
  }
  return null;
}
