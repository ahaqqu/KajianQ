import { FILTER_DIMENSIONS, type KajianQFilters } from "./filters";

/**
 * The domain→store filter mapping — Smart Router stage 3 (spec §3.3 item 3:
 * "index selection + SQL metadata filters (`source_type`, `madzhab`,
 * `grade IN …`, `principle_tags ANY …`)").
 *
 * **The invariant this module owns** (the reason it exists as its own file):
 * *the routing decision the trace publishes and the filter record the store
 * receives are the same object, and a dimension the store cannot express fails
 * the run loudly instead of being dropped.* Two silent failures are ruled out
 * by construction rather than by care:
 *
 * 1. **A dimension with no store key.** `FILTER_DIMENSIONS` is an exhaustive
 *    `Record<keyof KajianQFilters, …>`: adding a dimension to the filter type
 *    without naming the metadata key it maps to is a typecheck failure. Before
 *    this, `sourceType` and `principleTags` simply were not in the map — a
 *    route could decide "search the Quran, for the yusr lens" and the search
 *    would run over the whole corpus with no error, no trace entry, and no
 *    gate that notices. That is the failure this ticket's invariant forbids.
 * 2. **A key the store cannot express.** The store seam takes
 *    `Record<string, string | readonly string[]>`
 *    (`RagStore.similaritySearch`) and compiles it to
 *    `metadata->>$key = ANY($key::text[])`. Anything else — a number, a nested
 *    object, an unknown dimension name a caller invented (the spec's
 *    `source_type` snake_case spelling is the realistic near-miss) — is
 *    rejected here with a typed {@link FilterNotExpressibleError} that the
 *    retriever surfaces as its stage failure. A silently-ignored filter is an
 *    answer to a different question than the router decided to answer.
 *
 * Nothing here interprets what a value *means*: the keys and values are
 * opaque strings the domain pack owns.
 */

/** A filter dimension the store cannot express. Loud, typed, never a drop. */
export class FilterNotExpressibleError extends Error {
  override readonly name = "FilterNotExpressibleError";
  /** The offending dimension name, as the caller wrote it. */
  readonly dimension: string;
  /** Why it cannot be expressed — a stable, short reason. */
  readonly reason: "unknown_dimension" | "not_a_string_list";

  constructor(dimension: string, reason: "unknown_dimension" | "not_a_string_list") {
    super(`retrieval filter ${JSON.stringify(dimension)} is not expressible: ${reason}`);
    this.dimension = dimension;
    this.reason = reason;
  }
}

/** One expressible filter dimension: its metadata key and its value set. */
export type FilterEntry = {
  /**
   * The domain dimension — one of `KajianQFilters`' keys, held by the compiler
   * so the relaxation order (which matches on the dimension) and this entry
   * cannot drift apart without a typecheck failure.
   */
  dimension: keyof KajianQFilters;
  /** The `metadata` JSONB key the store binds — always a parameter, never SQL. */
  key: string;
  values: readonly string[];
};

/**
 * Normalize one dimension's raw value to its value set, or `null` when the
 * dimension constrains nothing. Throws on a value the store cannot bind.
 *
 * An absent dimension, a blank string, and an empty (or all-blank) list all
 * mean "unconstrained" — the same convention the router's reply uses (`""` or
 * `[]`), so a model that leaves a filter out never accidentally narrows
 * retrieval to nothing.
 */
function valuesOf(dimension: string, raw: unknown): readonly string[] | null {
  if (raw === undefined || raw === null) return null;
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : null;
  if (list === null) throw new FilterNotExpressibleError(dimension, "not_a_string_list");
  const out: string[] = [];
  for (const value of list) {
    if (typeof value !== "string") {
      throw new FilterNotExpressibleError(dimension, "not_a_string_list");
    }
    const trimmed = value.trim();
    if (trimmed === "" || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out.length > 0 ? out : null;
}

/**
 * Read a filters object into the store's expressible entries, in the declared
 * dimension order (deterministic: two runs over equal filters bind identical
 * parameter lists). Throws on a dimension the store cannot express — including
 * a key this pack does not declare, whatever it is spelled.
 */
export function filterEntries(filters: KajianQFilters | undefined): FilterEntry[] {
  const source = (filters ?? {}) as Record<string, unknown>;
  for (const dimension of Object.keys(source)) {
    if (!Object.hasOwn(FILTER_DIMENSIONS, dimension)) {
      throw new FilterNotExpressibleError(dimension, "unknown_dimension");
    }
  }
  const entries: FilterEntry[] = [];
  for (const [dimension, key] of Object.entries(FILTER_DIMENSIONS) as [
    keyof KajianQFilters,
    string,
  ][]) {
    const values = valuesOf(dimension, source[dimension]);
    if (values !== null) entries.push({ dimension, key, values });
  }
  return entries;
}

/**
 * The store's opaque metadata-filter record for already-read entries. Every
 * values list is a list, matching the seam's `string | readonly string[]` — the
 * one shape `metadata->>key = ANY($n::text[])` can bind for every dimension.
 * The record is keyed by the store's own key, which is also the space the
 * relaxation's `retained`/`dropped` pair is written in.
 */
export function entriesToFilters(entries: readonly FilterEntry[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of entries) out[entry.key] = [...entry.values];
  return out;
}

/**
 * Map the domain filters to the store's opaque metadata-filter record — the
 * same record `entriesToFilters` builds from `filterEntries`, so a caller that
 * has already read the entries (the routing decision, which also needs the
 * source selection out of them) does not map them twice or by a second rule.
 */
export function metadataFilters(filters: KajianQFilters | undefined): Record<string, string[]> {
  return entriesToFilters(filterEntries(filters));
}

/**
 * The order filter relaxation gives up dimensions when a search matches
 * nothing (see the retriever). Cheapest-to-be-wrong hint first, the routing
 * *decision* last:
 *
 * 1. `principleTags` — the Principle Index is not ingested yet (#16), so a tag
 *    filter that matches nothing is the expected state today, not a defect in
 *    the route.
 * 2. `textLayer` — no corpus row carries the key, and the router's hint for it
 *    was observed wrong on a Quran question.
 * 3-5. `grade`, `madzhab`, then `sourceType` — each an actual routing decision;
 *    `sourceType` goes last because dropping it is the widest possible
 *    widening (every source back in play) and the trace must show the route
 *    gave up its own decision only after every cheaper hint.
 *
 * The type is `keyof KajianQFilters` on purpose: the order matches on the
 * domain *dimension*, while the trace records the store *key*, and this is the
 * one place the two names meet. Naming a dimension the type does not declare is
 * a typecheck failure; omitting one is caught by the set-equality test beside
 * this module, so neither direction of drift is silent.
 */
export const RELAXATION_ORDER = [
  "principleTags",
  "textLayer",
  "grade",
  "madzhab",
  "sourceType",
] as const satisfies readonly (keyof KajianQFilters)[];

/**
 * The next dimension still in play to drop, or `undefined` when none is left.
 * `entries` is the live set, so a drop is simply removing the returned entry
 * before the retry — the set the retry binds is the set the trace can
 * reconstruct (`intended − dropped`).
 */
export function nextRelaxation(entries: readonly FilterEntry[]): FilterEntry | undefined {
  for (const dimension of RELAXATION_ORDER) {
    const entry = entries.find((candidate) => candidate.dimension === dimension);
    if (entry !== undefined) return entry;
  }
  return undefined;
}
