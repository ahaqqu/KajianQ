# ADR-0012: Per-chain hadith grades over one flattened grade per matn (v2)

## Decision

Grades become **per-chain, with grader attribution**, surfaced in citations, answers and the trace. v2 ingests the Sanadset isnad data as structured relational rows — narrators and chains — reconciled against the v1 hadith corpus by conservative matn matching, and the Grade vocabulary gains its per-chain meaning.

The migration is additive: v1 rows and their embeddings are untouched, and reconciliation never overwrites an existing row.

## Why

Hadith science grades chains, not texts: the same matn can be sahih through one isnad and weak through another, and weak chains can strengthen one another through corroboration. A trust-first product cannot keep a flattened model that is occasionally and confidently wrong — that is an integrity risk rather than a simplification.

Rejected: keeping the flattened per-matn grade; replacing the v1 hadith corpus wholesale, where additive reconciliation is cheaper and preserves v1 data; a graph database or a GraphRAG pipeline, because isnads are structured relational data and recursive SQL over the same store suffices — no entity-graph sensemaking is needed.

## Consequences

- The change is an additive migration plus a semantic upgrade of the grade vocabulary, not a re-ingest.
- Citations, answers, the trace and the grade filter carry per-chain grades with their grader.
- Until v2 lands, the grade filter reads the consolidated per-matn field, so grader-level disagreement is visible in trace metadata but not filterable (ADR-0026).
- **Revisit when** the corpus's chains are reconciled and every downstream consumer reads the per-chain grade — the flattened field then retires.
