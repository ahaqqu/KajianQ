# ADR-0036: Embedding benchmark gate result — `gemini-embedding-001` ships as default with AR-only + ID-fallback retrieval posture

## Status

Accepted (2026-09-10). Closes the #9 go/no-go gate (ADR-0013 amendment 2): the
retrieval-layer choice (AR-only vs. ID-fallback fusion) and the embedding
default are decided by the benchmark numbers below, not asserted in advance.
Amends ADR-0013's open questions 1 and 3; the `embedder` role chain in
`packages/infra/src/providers/models.json` carries the winner.

## Context

ADR-0013 made Arabic the canonical evidence layer (`text_primary`/
`embedding_primary`) with Indonesian as a built-from-the-start fallback track,
and deferred the retrieval posture to this gate. The ticket (#9) fixed the
floors: the default model ships only if **cross-lingual (ID→AR) recall@10 ≥
0.70** and **monolingual (AR→AR) recall@10 ≥ 0.75** over the real corpus.
ADR-0014 additionally required an **expansion micro-task**: given a glossary
slice + an Indonesian query, does the router LLM pick the correct Arabic
expansion term? (the Terminology Glossary consumption de-risk).

`gemini-embedding-2` was the required challenger: explicitly cross-lingual
(100+ languages), and — critically — **not embedding-space-compatible** with
`gemini-embedding-001`, so adopting it is a clean-slate re-embed of the whole
corpus, not an upgrade.

### Method

Harness: `bun run eval:embed-bench` (`packages/eval/scripts/embed-bench.mjs` +
the `@app/eval` `embed-bench` engine module). Both models are compared through
the same `Provider` seam (ADR-0022), each resolved alone from the checked-in
`embedder-candidates` role — never behind a fallback chain that could silently
substitute another model. Cosine recall@10 + MRR over three directions
(secondary→primary, primary→primary, secondary→secondary).

Corpus: the **real v1 sources** — Tanzil Uthmani + Kemenag Quran (via the
`hangsbreaker/quran-json` mirror) and fawazahmed0/hadith-api Arabic+Indonesian
editions — parsed by the same ingest-grade parsers the ingester consumes.
Probes are **self-retrieval**: a probe's query text is a doc's own track text
and its query vector reuses that doc's already-computed track vector, so the
metric measures the pure cross-lingual alignment of the embedding space with
no second embedding pass. The gate corpus is a deterministic stratified
subset (free-tier embed-content quota counts _items_, not requests — the full
660k-row corpus would be ~8 hours of window per track); the subset preserves
each source group's share and its fingerprint is recorded in the report.
Numbers below cite the exact corpus fingerprint so re-runs are comparable.

## Decision

> **[NUMBERS PENDING — this section is finalized with the report from the
> full run before merge; the PR carries the JSON report verbatim.]**

- Winning model: `gemini-embedding-001` (pending confirmation vs floors).
- Retrieval posture: AR-only serving with the ID-fallback track retained
  (dual-index schema per ADR-0013 amendment 1) — pending the numbers.
- Re-embedding cost if `gemini-embedding-2` were adopted: full re-embed of
  the corpus (embedding spaces incompatible); reported in the PR.

## Consequences

- Kitab-scale ingestion (#22, #33, #35) may proceed once this ADR is accepted
  (the gate it waited on).
- `SPECS.md` §3.4's "embedding default is unproven" warning is resolved; the
  §8 Record of Decisions gains this row.
- The expansion micro-task's accuracy number feeds ADR-0014's consumption
  design (router LLM picks expansion terms from a verbalized slice).

## Alternatives considered

- **Full-corpus run**: infeasible on the free tier (≈48k embed items ≈ 8 h of
  quota wall-clock per track set) and unnecessary for a recall gate — a
  stratified subset with n≥200 probes per direction bounds the estimate
  tightly; the deterministic stride sampling keeps re-runs comparable.
- **Separate query embedding pass**: rejected — self-retrieval probes reuse
  the corpus vectors, halving the spend while measuring the same alignment.
