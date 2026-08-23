# ADR-0016: GraphRAG adoption rule — bounded curated concept structures, corpus-wide entity-graph RAG rejected by default

## Status

Accepted (2026-08-23). Records the standing rule so the question is not re-litigated per ticket. Does not re-open ADR-0012 (isnad = recursive SQL, no graph DB). Amends the design baseline for every "add a knowledge layer" proposal: the burden of proof is now stated in advance.

## Context

Community GraphRAG (Microsoft GraphRAG, LightRAG, and successors up to 2026) builds an entity graph over the *document corpus* — LLM extraction of entities/relations from chunks, community clustering, then graph over retrieval. It is designed for corpus-scale sensemaking over messy, previously unread document sets: investigative corpora, support-ticket triage, "what does this pile of documents say" questions.

KajianQ's corpus and task differ on each axis that motivates that architecture:

1. **The corpus is read, not unread.** Its important structure — kitab, author, volume, page, bab, matn/sharh, isnad, grade, madzhab — is *bibliographic and scholarly*, authored over a millennium, and already machine-actionable as metadata.
2. **The trust model is citation-first.** Every answer must resolve back to `QS` / `HR N (Grade)` / `Kitab, Author, Vol:Page:Bab`. Implicit LLM-extracted corpus graphs are optimized for aggregation, not anchoring; they add a layer that is hard to cite and expensive to validate against 2M+ classical Arabic chunks with current tooling.
3. **The knowledge layers the product actually needs are small, bounded, and authoritative**: the terminology concept graph (#24, term-level, human-reviewed), the Narrator Graph (#29, isnad relational rows, recursive SQL over Postgres per ADR-0012), the Principle Index (10–20 verified maxims), and `concept_links` for *curated or verified* passage relations (#22 already states this). None require entity-graph-community detection at corpus scale.

Choosing knowledge-graph-by-document-extraction anyway would trade verifiable structure for inferred structure and pay in validation cost — the opposite direction of the trust objective.

## Decision

**No corpus-wide, LLM-extracted entity-graph RAG.** Graph-shaped knowledge ships only as **bounded curated concept structures**, each: (a) built from license-safe or authoritative sources, (b) human-reviewed or verifiable, (c) injected as a visible slice in prompt and Trace, (d) degraded to no-expansion (graceful) on misses. New structures follow that same pattern, plain Postgres over a graph database, recursive SQL over graph traversal engines.

**Gate for any future proposal** (post-v1 revisit only if all four hold):
1. A documented user-question class that current layers provably cannot serve (eval evidence, not anecdote).
2. It adds a *new* typed relation class not expressible as extension of the existing four structures.
3. Its build + validation + review cost fits the stated curation capacity (Label Studio-reviewed, sampled cross-vendor).
4. It lands as a *new bounded table set* behind RagStore — never as a migration to a graph DB and never as retrieval-over-implicit-corpus-graph.

## Alternatives considered

- **Adopt community GraphRAG for the full corpus** — rejected above.
- **Defer with no rule** — rejected: the question recurs per ticket and drifts by default.
- **Pure hybrid retrieval + Smart Router + curated layers** (current baseline) — accepted as the v1/v2 architecture; this ADR freezes it as a decided position with revisit criteria rather than an unsettled default.

## Consequences

- Roadmap is unchanged: #24 concept graph, #29 isnad, #22 `concept_links`, #25 Deep Think all sit inside the rule.
- The "wisdom over text search" objective is served by the curated layers above plus the Generator's classical-reasoning-surfacing discipline (ADR-0015); corpus-wide inferred graphs are not a required ingredient.
- A future proposal that clears the four-part gate is an ADR amending this one — not an exception smuggled into a ticket.
