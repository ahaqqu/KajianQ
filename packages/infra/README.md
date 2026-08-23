# infra — persistence & blob seams

Adapters the engine and apps consume; engine code never imports a database or
vendor client directly (ADR-0008, ADR-0009). Foundation skeleton: only the
template's runtime adapters exist yet. Real adapters arrive in later tickets:

- **`RagStore`** (#4) — Neon Postgres + pgvector, the single seam for all
  structured persistence. Engine/app code goes through it; nothing else holds
  SQL or a DB client except migrations.
- **`Provider`** (#5) — LLM/embedding calls (`generate`/`stream`/`embed`) behind
  the vendor allowlist with per-query cost tracing.
- **`ObjectStore`** — already present (R2). Holds raw source archives and
  `text_raw` backups.

## First Neon migration (owned by #4)

The first RagStore migration creates the full v1 schema (see #4). Per
**ADR-0014**, it must include the four terminology concept-graph tables so the
foundation is not re-entered:

- `concept` — language-neutral concept node (slug, gloss, source).
- `lemma` — per-language lemma (`lang`, `written_rep`, optional `translit`,
  `embedding VECTOR(1024)` for BGE-M3 candidate retrieval).
- `concept_relation` — typed edges: `broader` / `narrower` / `related` /
  `part_of`, with `evidence_ayah_ids`.
- `lemma_evidence` — ties each lemma to the aligned ayah pairs that justify it.

These are term-level (distinct from passage-level `concept_links`). Exact
column sets are defined in `adr/0014-bilingual-terminology-concept-graph.md`;
#4 implements them in the migration, not here.
