/**
 * The two deterministic retrieval expansions, behind one import path — a pure
 * convenience barrel, the same pattern `chat-stages.ts` takes for the pipeline
 * composition module and for the same reason: `chat-retriever.ts` imports five
 * modules already (the agentic cap), and the expansion API is one subject
 * however many files it is split across for the 300-line cap.
 *
 * The split itself is by **anchor** and stays meaningful: `chat-scope-expansion`
 * widens around a scope the **question named** (ADR-0045), and
 * `chat-neighbour-expansion` widens around the verses **retrieval returned**
 * (ADR-0049). They share the bounded-read discipline, the trace-reporting
 * shape and the chunk builder; they do not share a trigger.
 */
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
