# ADR-0016: No corpus-wide extracted entity-graph RAG; graph-shaped knowledge ships as bounded curated structures

## Decision

**Corpus-wide, model-extracted entity-graph RAG is rejected.** Graph-shaped knowledge ships only as **bounded curated concept structures**, each built from licence-safe or authoritative sources, human-reviewed or verifiable, injected as a visible slice in the prompt and the trace, and degrading gracefully to no expansion on a miss. They live as plain tables in the same store, with recursive SQL serving traversal; no graph database enters.

A future proposal clears a four-part gate: a documented question class the current layers provably cannot serve, from eval evidence rather than anecdote; a **new** typed relation class not expressible as an extension of the existing structures; a build, validation and review cost that fits the stated curation capacity; and a landing as a new bounded table set behind the store seam — never a migration to a graph database and never retrieval over an implicit corpus graph.

## Why

The community architecture builds an entity graph over a corpus the system has not read, for corpus-scale sensemaking. This corpus is read: its important structure — kitab, author, volume, page, chapter, matn and commentary, isnad, grade, madzhab — is bibliographic and scholarly and already machine-actionable as metadata. The trust model is citation-first, and an inferred layer is hard to cite and expensive to validate; and the knowledge layers the product needs are small, bounded and authoritative. Choosing inferred structure anyway trades verifiable structure for inferred structure and pays in validation cost, the opposite direction of the trust objective.

Rejected: adopting it for the full corpus; deferring the question with no rule, because it recurs per ticket and drifts by default.

## Consequences

- The knowledge-layer roadmap sits inside the rule, and the "wisdom over text search" objective is served by the curated layers plus the generator's classical-reasoning discipline (ADR-0015).
- A proposal that clears the gate is a new record, not an exception smuggled into a ticket.
- **Revisit when** a documented question class defeats the current layers on eval evidence, or a new typed relation class appears that the existing structures cannot express.
