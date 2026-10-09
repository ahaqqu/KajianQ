/**
 * The parts `chat-retriever.ts` is assembled from, behind one import path — a
 * pure convenience barrel, the same pattern `chat-stages.ts` takes for the
 * pipeline composition module and for the same reason: the retriever stage is
 * already at the agentic 5-import cap, and these are one subject however many
 * files the 300-line cap splits them across.
 *
 * The split itself stays meaningful. `chat-fusion` is the pure arithmetic
 * (RRF + hierarchy bonuses); `chat-filter-policy` is the store-facing filter
 * mapping (the exhaustive dimension map, the loud unexpressible-dimension
 * failure, and the relaxation order); `chat-scope-expansion` widens
 * around a scope the **question named** (ADR-0045); `chat-neighbour-expansion`
 * widens around the verses **retrieval returned** (ADR-0049). The two
 * expansions share the bounded-read discipline, the trace-reporting shape and
 * the chunk builder; they do not share a trigger.
 */
export { HIERARCHY_BONUS, RRF_K, hierarchyBonus, rrfFuse, type TrackHit } from "./chat-fusion";
export {
  FilterNotExpressibleError,
  RELAXATION_ORDER,
  filterEntries,
  metadataFilters,
  nextRelaxation,
  type FilterEntry,
} from "./chat-filter-policy";
export { createFilterRelaxation } from "./chat-filter-relaxation";
export {
  DEFAULT_SCOPE_EXPANSION_CAP,
  SCOPE_EXPANSION_ORIGIN,
  SCOPE_KEY_SURAH,
  expandSurahScope,
  expansionChunk,
  type ScopeBridge,
  type ScopeChildRow,
  type ScopeExpansion,
  type ScopeStore,
} from "./chat-scope-expansion";
export {
  DEFAULT_NEIGHBOUR_CAP,
  DEFAULT_NEIGHBOUR_RADIUS,
  NEIGHBOUR_EXPANSION_ORIGIN,
  expandVerseNeighbours,
  type NeighbourBridge,
  type NeighbourChildRow,
  type NeighbourExpansion,
  type NeighbourStore,
} from "./chat-neighbour-expansion";
