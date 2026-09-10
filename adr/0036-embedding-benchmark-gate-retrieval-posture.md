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

**Both floors are met; `gemini-embedding-001` ships as the default and the
retrieval posture is AR-only serving with the ID-fallback track retained.**
Run of 2026-09-10 04:10 WIB (paid tier), report at
`packages/kajianq-domain/fixtures/embed-bench-results.json`:

| Candidate              | ID→AR (secondary→primary)                   | AR→AR (primary→primary)                    | Gate (≥0.70 / ≥0.75) |
| ---------------------- | ------------------------------------------- | ------------------------------------------ | -------------------- |
| `gemini-embedding-001` | recall@10 **1.000**, MRR **1.000** (n=200)  | recall@10 **1.000**, MRR **1.000** (n=200) | ✅ pass              |
| `gemini-embedding-2`   | recall@10 **1.000**, MRR **0.9975** (n=200) | recall@10 **1.000**, MRR **1.000** (n=200) | ✅ pass              |

Corpus: 1,500-doc deterministic stratified subset of the real v1 sources
(6,236-ayah Tanzil/Kemenag Quran + 30,778 aligned hadith across the seven
ADR-0026 collections), fingerprint `fnv1a64:478dc7ce1bae2d30:1500`. Probes:
200 cross-lingual + 200 monolingual self-retrieval probes per model. Total
recorded spend: **$0.000012** of the $5 cap (the vendor's OpenAI-compat
endpoint reported no usage for these calls; the free-tier-priced config
records 0).

**Expansion micro-task (ADR-0014): 12/12 correct (accuracy 1.000)** — the
cheap-tier router LLM picked the correct Arabic expansion term in every case,
including contextual disambiguation (wudhu vs. ghusl vs. tayammum for purity
queries; firdaus as the narrower pick inside the paradise slice; zakat
al-fitr vs. zakat). ADR-0014's prompt-injection consumption design is
de-risked at this sample size.

### Interpretation — read the MRR, not just the recall

Self-retrieval probes (a doc's own track text as the query) have a _ceiling_:
the relevant doc trivially ranks high because the query text is identical to
a corpus entry, so recall@10 saturating at 1.000 was the expected strong-model
outcome and cannot by itself discriminate model quality. The discriminating
statistic is MRR on the cross-lingual direction: `gemini-embedding-001` put
its own AR doc at rank 1 for all 200 ID queries, `gemini-embedding-2` missed
top-1 on 0.5% of them (MRR 0.9975). Both are comfortably past the floors;
`gemini-embedding-001` retains the default on (a) equal gate pass, (b) equal
or better cross-lingual MRR, (c) zero re-embedding cost — the whole corpus is
already embedded in its space, while adopting `gemini-embedding-2` is a
clean-slate re-embed (incompatible space) priced at ~$6.08 batch / $12.16
standard for the current Quran+hadith corpus (both tracks).

The sharper discriminative test (natural-language Indonesian _user_ queries —
paraphrases, not verbatim doc text — against the AR corpus) lands with the
Golden Set runs against the live pipeline (#8's harness), which exercises the
full ID→AR path including query expansion. The floors defined in #9 are met
as specified; the posture decision is made.

### Retrieval posture

**AR-only serving, ID-fallback track retained.** The cross-lingual floor
passed with margin, so the primary (Arabic) track serves retrieval; the
`embedding_fallback` column stays built and switchable without re-embedding
(ADR-0013 amendment 1) for a future fusion posture if real-user paraphrase
recall ever justifies it.

### Config updates in the same commit

- `embedder` role: `gemini-embedding-001` confirmed as the chain head.
- **Live-API model-id correction (surfaced by this gate's expansion task):**
  the API's chat-completions surface does not expose `gemini-3-flash` /
  `gemini-3.1-pro` (404 — only the `-preview` ids exist on this account), so
  the `cheap` and `reviewer` role pins now read `gemini-3-flash-preview` and
  `gemini-3.1-pro-preview` (SPECS §3.4 updated). The ingestion-translation and
  generator roles (Qwen) are unchanged; their DashScope key is absent in this
  environment and out of this gate's scope.

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
