# ADR-0008: Postgres and pgvector behind the `RagStore` adapter, not D1 or a hosted vector index

## Decision

1. **One persistence seam.** `RagStore`, owned by `packages/infra`, is the only place SQL and a database driver live. Engine packages stay runtime- and vendor-agnostic: they depend on the seam, never on the store behind it.
2. **The store is Postgres with pgvector.** The router's core is rich metadata filtering over the corpus plus hybrid search that fuses vector similarity with lexical matches, and that is what the store must express.
3. **The engine names none of the domain's filters.** The filter type is a parameter of the seam, and the domain pack instantiates it.
4. **Chat sessions, messages, traces, feedback and eval ledgers live behind the same seam.** Large artifacts — raw exports and snapshot archives — go through the `ObjectStore` seam instead.
5. **Migrations ship with the adapter,** so a store change is an adapter change.

## Why

The template's SQLite edge database has no vector extension, so the hybrid search and metadata filtering the router is built on cannot be expressed there. A hosted vector index filters metadata weakly and would bind the engine to one vendor, against the reusability goal. Both alternatives also place the store's shape in the engine's path rather than behind a seam, which is what lets batch ingestion run off the serving runtime while the API keeps serving.

Rejected: the template's edge database and its local-first sync package; a hosted vector index; a second persistence path beside the adapter.

## Consequences

- Direct database access outside the adapter and its migrations is a defect the boundary gate scans for (ADR-0019).
- The store's hosting and transport are their own decision (ADR-0044); swapping the host changes the adapter, not the engine.
- Both embedding tracks are stored from the start, so the retrieval posture is switchable in the store's query layer without re-ingestion (ADR-0013, ADR-0020).
- **Revisit when** a consumer needs a second store dialect, or a retrieval need appears that the seam cannot express without leaking SQL upward.
