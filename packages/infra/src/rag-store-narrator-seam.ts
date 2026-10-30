import type { StoreError } from "@app/rag-core";
import type { Effect } from "effect";
import type { RagStoreNarratorWrites } from "./rag-store-narrator-write-seam";

export type {
  NarratorChainInsert,
  NarratorUpsert,
  RagStoreNarratorWrites,
} from "./rag-store-narrator-write-seam";
export { chainWriteProblem, narratorWriteProblem } from "./rag-store-narrator-write-seam";

/**
 * Narrator/graph half of the `RagStore` seam: the read surface over the
 * narrator catalogue and the ordered narrator chains attached to a child chunk,
 * plus the write surface that makes a re-run harmless (the `*Writes` half).
 *
 * The names here are **role names plus the domain columns the pack's rows carry**:
 * the engine stores and returns rows it never interprets, and the domain pack binds
 * these records to its own types (the chain record becomes the pack's chain type).
 * `kunya`, `laqab`, `tabaqa` and `reliabilityByCritic` are pass-through columns the
 * pack's own catalogue carries; the engine neither names them as concepts nor acts
 * on them, and a second product can store a different vocabulary behind the same
 * records. ADR-0019 leaves vocabulary outside the boundary wordlist to review
 * rather than mechanical enforcement; these pass-through columns are that
 * remainder, and the engine adds no behaviour on top of them.
 *
 * Two consequences are visible in the types rather than trusted to a caller:
 *
 * - **Order is data.** A chain's `narratorIds` is stored and returned exactly as
 *   given, duplicates included. A source row may concatenate parallel chains into
 *   one list, so the same narrator legitimately appears twice; any sort or dedupe
 *   in a read would silently rewrite the transmission it reports.
 * - **A grade never travels alone.** The chain record carries the grader beside
 *   the grade, and the schema refuses one without the other: a grade with no
 *   attribution is exactly the flattened evidence model the product rejects.
 *
 * Reads are exact-match and un-normalised by design: name folding and identity
 * resolution are domain logic, so the store matches the strings it is given and
 * returns every row that matches — a same-name pair is two narrators, never one.
 * Rows come back in a stable, collation-free order (`id`), and the domain pack
 * decides how to present them.
 */

/** One narrator row — a resolved transmitter, not a name surface. */
export type NarratorRecord = {
  id: string;
  /** The ingested canonical spelling (Arabic). Matched exactly by the name read. */
  canonicalNameAr: string;
  /** Every other spelling recorded for this narrator; the name read matches these too. */
  nameVariants: readonly string[];
  /** The teknonymic name element; stored and returned verbatim, never interpreted here. */
  kunya: string | null;
  /** The descriptive honorific; stored and returned verbatim, never interpreted here. */
  laqab: string | null;
  /** Hijri death year; null when unknown. */
  deathYear: number | null;
  /** The generation label as the source states it; stored verbatim and never coerced to a level. */
  tabaqa: string | null;
  /**
   * Critic key → that critic's assessment of this narrator. Opaque to the engine:
   * stored and returned verbatim, like `metadata`; the domain pack owns the value
   * shape, so a second product can carry a different one.
   */
  reliabilityByCritic: Readonly<Record<string, unknown>>;
  metadata: Readonly<Record<string, unknown>>;
};

/** One chain row: an ordered narrator sequence attached to a child chunk. */
export type NarratorChainRecord = {
  id: string;
  /** The child chunk whose text this chain transmits. */
  childId: string;
  /** The collection the chain comes from (domain vocabulary; never interpreted here). */
  collection: string;
  /**
   * The ordered chain. Order IS the chain: returned exactly as stored, duplicates
   * included. Array elements are not foreign keys, so an id may name a narrator the
   * catalogue does not carry — {@link NarratorIdsLookup} is how a caller finds out.
   */
  narratorIds: readonly string[];
  /** Per-chain classification, or null when no verdict exists; the seam never checks its vocabulary. */
  grade: string | null;
  /** The grader whose verdict `grade` is. Present exactly when `grade` is. */
  grader: string | null;
  /** The source's own address for this chain row, when it has one. */
  sourceRef: string | null;
};

/**
 * The canonical spelling of a narrator id: surrounding whitespace trimmed, one
 * matched brace pair stripped, lowercased.
 *
 * Only the whole-value form `{uuid}` is stripped, and only when the interior holds
 * no brace of its own (its own padding is trimmed). An unbalanced (`{uuid`,
 * `uuid}`), doubled (`{{uuid}}`) or empty (`{}`) pair is not a spelling of a uuid,
 * so it is passed through unchanged and the query rejects it as a `constraint`
 * StoreError instead of this function repairing it into a resolved id or a blank.
 *
 * Postgres accepts the braced, any-case form and returns the canonical lowercase
 * form, but not the padded spellings the seam tolerates; trimming and the
 * matched-pair strip above are the seam's own canonicalisation, so a read maps
 * rows and caller ids under this form while `missingIds` keeps the caller's own
 * spelling.
 */
export function canonicalNarratorId(id: string): string {
  const trimmed = id.trim();
  const inner = /^\{([^{}]+)\}$/.exec(trimmed)?.[1]?.trim();
  return (inner !== undefined && inner !== "" ? inner : trimmed).toLowerCase();
}

/**
 * The answer to a by-id narrator lookup. `narrators` holds the rows that exist, in
 * the caller's order; `missingIds` names the requested ids with no row, also in the
 * caller's order. Both lists are deduplicated by canonical id, so spellings of one
 * uuid (case, braces, surrounding whitespace) are one id; `missingIds` carries the
 * caller's first spelling of an id that has no row.
 *
 * The second field exists because a chain's narrator ids are not foreign keys: a
 * caller resolving a chain must be able to tell "this narrator is unknown to the
 * catalogue" from "I forgot to resolve it", so an unknown id is reported, never
 * silently dropped.
 */
export type NarratorIdsLookup = {
  narrators: readonly NarratorRecord[];
  missingIds: readonly string[];
};

/** One keyset page of chains in a collection, ordered by the opaque `id` cursor. */
export type ChainPage = {
  rows: readonly NarratorChainRecord[];
  /** The cursor for the next page; null when this page is the end of the set. */
  nextAfterId: string | null;
};

export interface RagStoreNarrators extends RagStoreNarratorWrites {
  /**
   * Narrators whose canonical name **or** any recorded variant equals `name`, at
   * most `limit` rows, in `id` order. The match is exact and unnormalised: folding
   * an Arabic spelling is the domain pack's job, so this read cannot accidentally
   * match two spellings the caller considers distinct. Several rows can share a
   * name — that ambiguity is what the domain's resolution settles, so the read
   * returns all of them and never picks one.
   *
   * `limit <= 0` returns no rows without issuing a query; a blank `name` matches
   * nothing (it is not a spelling any stored row carries).
   */
  findNarratorsByName(
    name: string,
    opts: { limit: number },
  ): Effect.Effect<readonly NarratorRecord[], StoreError>;

  /**
   * The narrator rows for the given ids, in the caller's order and deduplicated by
   * canonical id, with the ids that have no row reported separately. Case, braces
   * and surrounding whitespace are spelling, not identity: every spelling of one
   * uuid addresses the same narrator. A malformed id fails as a `constraint`
   * StoreError rather than being skipped; a blank id is ignored (it addresses
   * nothing) and is the one input that is not reported back.
   */
  getNarratorsByIds(ids: readonly string[]): Effect.Effect<NarratorIdsLookup, StoreError>;

  /**
   * The chains attached to one child chunk, at most `limit` rows, ordered by the
   * store-assigned insertion sequence — a neutral order, never a grade ranking,
   * because multiple chains are presented to a reader neutrally. `created_at` is
   * the transaction timestamp and the random `id` is not insertion order, so
   * neither decides this read. An unknown child id returns an empty list (a
   * child-less chain cannot exist: the schema's foreign key cascades). `limit <= 0`
   * returns no rows without issuing a query.
   */
  listChainsForChild(
    childId: string,
    opts: { limit: number },
  ): Effect.Effect<readonly NarratorChainRecord[], StoreError>;

  /**
   * A keyset page over one collection's chains, ordered by `id`. `afterId` is the
   * previous page's `nextAfterId`; absent starts at the first row. A page is at most
   * `limit` rows, and `nextAfterId` is the last returned id when the page is full
   * (there may be more) or null when it is short of `limit` (the set is exhausted).
   * `limit <= 0` returns an empty page without issuing a query.
   */
  listChainsByCollection(
    collection: string,
    opts: { afterId?: string; limit: number },
  ): Effect.Effect<ChainPage, StoreError>;
}
