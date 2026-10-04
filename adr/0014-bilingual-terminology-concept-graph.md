# ADR-0014: Bilingual terminology reaches retrieval as a concept graph, not a flat table

## Decision

Adopt a **bilingual terminology concept graph**: a language-neutral concept node anchors lemmas in each language,
connected by typed SKOS-style relations — broader, narrower, related, part-of. Build it from the aligned Quran and
hadith ayah pairs by extraction with human review, and consume it by injecting the relevant concept slice into the
router prompt as expansion candidates, never by replacing the original query. Selected expansion terms are recorded on
the trace; a wrong expansion only retrieves noise the rank fusion downweights. Extraction emits `{ar_phrase,
id_phrase, relation, confidence, rationale}`, `relation` drawn from `equivalent, broader, narrower, related, part_of`;
`equivalent` is the verdict collapsing two lemmas onto one concept, not a graph edge.

The four terminology tables live in the **domain pack**, not the engine schema, and the product tables — the principle
index and the golden set — follow the same rule; the engine schema keeps only the domain-agnostic corpus, trace, chat,
session, feedback, ledger, and model-config tables. `lemma_evidence.ayah_pair_id` stays a plain `uuid`, loose until
the aligned-ayah table lands. A sense table is added only when a lemma genuinely splits across concepts.

The consumer looks query terms up in the lemma table, takes the one-to-two-hop neighbour subgraph, verbalizes it
compactly, and injects it as Arabic expansion candidates for the model to pick. Document-graph builders are rejected.

## Why

One-to-one word translation is the minority case here: Arabic is root-and-pattern, Indonesian is affixing, and the
mappings are often many-to-many with hierarchical structure a flat variants set throws away — a narrower term is not
an interchangeable synonym. The concept model is a decades-old, well-specified idea, not an invention: terminology
standards and lexical models converge on a concept node with per-language lemmas and typed relations, and Postgres is
the right store for this scale and consumer — a model wanting structured data, not a graph query language. It
sacrifices only reasoning features nothing here needs, leaving interchange RDF emittable later. The graph is
product-domain logic — religious vocabulary anchored to aligned Quran and hadith pairs — so an engine package would
put Islamic-domain logic in the engine and force a second consumer to inherit an Islamic-knowledge schema. The
licences shape the pipeline: permissive corpora seed and validate, a share-alike Arabic wordnet keeps derived
redistributions share-alike, and copyleft ontology may be consulted but never copied into this MIT repository.
Indonesian is the weak side, so candidate generation stays generous there, the model tie-breaking rather than a
threshold; the word-alignment toolchain is archived and sentence encoders are unvalidated at word level, so embeddings
propose candidates, the human the precision gate. Disambiguation belongs at the router: the same term means different
Arabic terms before and after a major impurity, which no static lookup can call — and document-graph builders are
rejected because they build graphs from corpora. Ruled out: a non-commercial lexical database, incompatible with this
licence; a dictionary with no clean permissive digital edition; a modern copyrighted dictionary, a human reference
only; and the institutional glossaries, with no open machine-readable version, so the mapping stays human-curated.

## Consequences

The build pipeline, in order: seed from the licence-safe resources; lemmatize with the hand-verified Quranic
morphology whose annotation _is_ the lemma, a morphology tool with root-based clustering for classical hadith forms,
and an Indonesian lemma pipeline whose dictionary fallback carries a curated list of Arabic-derived religious terms;
extract term pairs per aligned sentence under a strict schema, each phrase a verbatim span anchorable back to the
corpus; cluster by embedding lemmas into a shared space and resolving neighbours into concept nodes with typed edges
in a second pass — the embeddings group, the model types and places; review in uncertainty order — cross-pair merges,
then pairs where two independent passes disagreed, then low-confidence items — with confidence ranking review order,
never replacing it; load, each lemma tied to its source ayah pairs. The deliverable is a concept graph, not a flat
bilingual table; the glossary stays query-enrichment-only and trace-visible, and the engine schema gains none of the
terminology tables, so DARS stays domain-agnostic. Arabic-canonical retrieval gains a structured expansion channel
bridging Indonesian queries to Arabic evidence explicitly and verifiably, reducing reliance on the embedding model's
unverified cross-lingual behaviour. The embedding gate's expansion micro-task remains the first real evidence for
word-level cross-lingual alignment; hadith Arabic lemmatization quality stays an honest gap mitigated by root-based
clustering and human review. Glossary completeness at v1 is unknown until extraction runs; missing concepts degrade to
no expansion, so the risk is graceful, and the graph grows incrementally. Two future paths are recorded, not taken: a
graph-query backend if the graph outgrows a single prompt slice, and a possible merge of the passage-level
`concept_links` table with the term-level graph once it is in use.
