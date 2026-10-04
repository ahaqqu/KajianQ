# ADR-0014: Bilingual terminology reaches retrieval as a concept graph, not a flat table

## Decision

Adopt a **bilingual terminology concept graph**: a language-neutral concept node anchors lemmas in each language,
connected by typed SKOS-style relations — broader, narrower, related, part-of. Build it from the aligned Quran ayah
pairs and the aligned hadith pairs by extraction with human review, and consume it by injecting the relevant concept
slice into the router prompt as expansion candidates, never by replacing the original query. The selected expansion
terms are recorded on the trace, and a wrong expansion only retrieves noise the rank fusion downweights.

The four terminology tables live in the **domain pack**, not the engine schema: the graph is product-domain logic —
Arabic-to-Indonesian religious vocabulary anchored to aligned Quran and hadith pairs — so placing it in an engine
package would put Islamic-domain logic in the engine and force any second consumer to inherit an Islamic-knowledge
schema. The product tables follow the same rule; the engine schema keeps only the domain-agnostic corpus, trace, chat,
session, feedback, ledger, and model-config tables. A sense table is added only when a lemma genuinely splits across
concepts, since the one-to-one mapping covers the majority of religious terms.

The consumer reads the query's surface terms against the lemma table, takes the one-to-two-hop neighbour subgraph,
verbalizes it to a compact block, and injects it as Arabic expansion candidates for the model to choose among — which
is the point, because the same Indonesian term means different Arabic terms before and after a major impurity and no
static lookup can make that call. Document-graph builders are not adopted: they build graphs from corpora.

## Why

For this vocabulary, one-to-one word translation is the minority case. Arabic is root-and-pattern, Indonesian is
affixing, and the mappings are often one-to-many or many-to-many with hierarchical structure that a flat
Indonesian-to-Arabic-variants set throws away — a narrower term is not an interchangeable synonym. The concept model
is a decades-old, well-specified idea rather than an invention: terminology standards and lexical vocabulary models
converge on a concept node with per-language lemmas and typed relations, and Postgres is the right store for this
scale and consumer — a model that wants structured data, not a graph query language. It sacrifices only reasoning
features nothing here needs and leaves the option to emit interchange RDF later. The licences are why the pipeline is
shaped as it is: permissive corpora seed and validate, a share-alike Arabic wordnet obliges derived redistributions to
stay share-alike, and copyleft ontology data may be consulted but never copied into this MIT repository. The
Indonesian side is the weak one, so candidate generation stays generous there and the model tie-breaks rather than a
similarity threshold; the dedicated word-alignment toolchain is archived and sentence encoders are not validated at
word level, which is why embeddings only propose candidates and the human is the precision gate. Ruled out: a
non-commercial lexical database, incompatible with this licence; a dictionary with no clean permissive digital
edition; a modern copyrighted dictionary, usable as a human reference only; and the institutional glossaries, for
which no open machine-readable version was found, so the Indonesian-to-Arabic mapping stays human-curated.

## Consequences

The build pipeline the decision binds, in order: seed from the licence-safe resources; lemmatize, taking the
hand-verified Quranic morphology whose annotation _is_ the lemma, a morphology tool with root-based clustering for
classical hadith forms, and an Indonesian lemma pipeline with a fast dictionary fallback; extract term pairs per
aligned sentence under a strict schema ; cluster by embedding lemmas into a shared space, generating nearest-neighbour
candidates and resolving them into concept nodes with typed edges in a second pass — the embeddings group, the model
types and places; review in uncertainty order, cross-pair merges first, then pairs where two independent passes
disagreed, then low-confidence items, with confidence ranking review order and never replacing it; and load, each
lemma tied to its source ayah pairs. The deliverable becomes a concept graph rather than a flat bilingual table; the
glossary's role as query-enrichment-only, and its visibility on the trace, are unchanged, and the engine schema gains
none of the terminology tables, so DARS stays domain-agnostic. Arabic-canonical retrieval gains a structured expansion
channel that bridges Indonesian queries to Arabic evidence explicitly and verifiably, reducing reliance on the
embedding model's unverified cross-lingual behaviour. The embedding gate's expansion micro-task remains the first real
evidence for word-level cross-lingual alignment, and hadith Arabic lemmatization quality stays an honest gap mitigated
by root-based clustering and human review. Glossary completeness at v1 is unknown until extraction runs; missing
concepts degrade to no expansion, so the risk is graceful rather than wrong answers, and the graph is designed to grow
incrementally.
