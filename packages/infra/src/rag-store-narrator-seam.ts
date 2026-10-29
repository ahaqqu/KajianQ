import type { StoreError } from "@app/rag-core";
import type { Effect } from "effect";

/**
 * Narrator/graph half of the `RagStore` seam: the read surface over the
 * narrator catalogue and the ordered narrator chains attached to a child chunk.
 *
 * The names here are **role names**, not the product's domain vocabulary: the
 * engine stores and returns rows it never interprets, and the domain pack binds
 * these records to its own types (the chain record becomes the pack's chain type).
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
  kunya: string | null;
  laqab: string | null;
  /** Hijri death year; null when unknown. */
  deathYear: number | null;
  /** The generation label as the source states it; never coerced to a level. */
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
 * The answer to a by-id narrator lookup. `narrators` holds the rows that exist, in
 * the caller's order; `missingIds` names the requested ids with no row, also in the
 * caller's order. Both lists are deduplicated by id.
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

export interface RagStoreNarrators {
  /**
   * Narrators whose canonical name **or** any recorded variant equals `name`, at
   * most `limit` rows, in `id` order. The match is exact and unnormalised: folding
   * an Arabic spelling is the domain pack's job, so this read cannot accidentally
   * match two spellings the caller considers distinct. Several rows can share a
   * name — that ambiguity is what the domain's resolution settles, so the read
   * returns all of them and never picks one.
   *
   * `limit <= 0` returns no rows without issuing a query; an empty `name` matches
   * nothing (no stored row has an empty name).
   */
  findNarratorsByName(
    name: string,
    opts: { limit: number },
  ): Effect.Effect<readonly NarratorRecord[], StoreError>;

  /**
   * The narrator rows for the given ids, in the caller's order and deduplicated,
   * with the ids that have no row reported separately. A malformed id fails as a
   * `constraint` StoreError rather than being skipped.
   */
  getNarratorsByIds(ids: readonly string[]): Effect.Effect<NarratorIdsLookup, StoreError>;

  /**
   * The chains attached to one child chunk, at most `limit` rows, ordered by
   * insertion (`created_at`, then `id`) — a neutral order, never a grade ranking,
   * because multiple chains are presented to a reader neutrally. An unknown child
   * id returns an empty list (a child-less chain cannot exist: the schema's foreign
   * key cascades). `limit <= 0` returns no rows without issuing a query.
   */
  listChainsForChild(
    childId: string,
    opts: { limit: number },
  ): Effect.Effect<readonly NarratorChainRecord[], StoreError>;

  /**
   * A keyset page over one collection's chains, ordered by `id`. `afterId` is the
   * previous page's `nextAfterId`; absent starts at the first row. A page is at most
   * `limit` rows, and `nextAfterId` is null when the page is the end of the set.
   * `limit <= 0` returns an empty page without issuing a query.
   */
  listChainsByCollection(
    collection: string,
    opts: { afterId?: string; limit: number },
  ): Effect.Effect<ChainPage, StoreError>;
}
