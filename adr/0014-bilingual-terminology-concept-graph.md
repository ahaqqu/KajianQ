# ADR-0014: Bilingual terminology reaches retrieval as a concept graph in the domain pack

## Decision

A language-neutral concept node anchors lemmas in each language, connected by typed relations; `equivalent` is the verdict that collapses two lemmas onto one concept, not an edge of the graph. The graph is built by extraction with human review, and consumed by injecting the relevant concept slice into the router prompt as Arabic expansion candidates — never by replacing the original query, and never as a hidden filter: the expansion terms the model selects are recorded on the trace. A wrong expansion only retrieves noise the rank fusion downweights.

The terminology tables live in the **domain pack**, not the engine schema, and the product's other domain tables follow the same rule; the engine schema keeps only the domain-agnostic corpus, trace, chat, session, feedback, ledger and model-config tables. A sense table is added only when a lemma genuinely splits across concepts.

## Why

One-to-one word translation is the minority case here: Arabic is root-and-pattern and Indonesian affixing, and the mappings are often many-to-many with a hierarchical structure a flat variants set throws away — a narrower term is not an interchangeable synonym. The concept model is a decades-old, well-specified idea rather than an invention, and the same store that holds the corpus can hold it: the consumer wants structured data, not a graph query language, and interchange RDF stays emittable later.

The graph is product-domain logic anchored to the product's own aligned corpora, so an engine package would put Islamic-domain knowledge in the engine and force a second consumer to inherit an Islamic-knowledge schema. Licences shape the build: permissive corpora seed and validate, a share-alike source keeps derived redistributions share-alike, and copyleft ontology may be consulted but never copied into this repository. Indonesian is the weak side, so candidate generation stays generous and the model tie-breaks rather than a threshold, with human review as the precision gate. Disambiguation belongs at the router, because the same term maps to different Arabic terms by context and no static lookup can call it.

Rejected: a flat bilingual variants table; a document-graph builder; a non-commercial lexical database, a dictionary with no permissive digital edition, and a copyrighted dictionary — each blocked by licence or by having no machine-readable form.

## Consequences

- The engine schema gains no terminology table, so the engine stays domain-agnostic.
- Expansion is query enrichment only, trace-visible, and degrades gracefully to no expansion on a miss, so the graph grows incrementally without a completeness cliff.
- Arabic-canonical retrieval gains a structured expansion channel that bridges Indonesian queries to Arabic evidence explicitly, reducing reliance on the embedding model's unverified cross-lingual behaviour.
- **Revisit when** the graph outgrows a single prompt slice (a graph-query backend is the recorded path), or a passage-level relation table is ready to merge with the term-level graph.
