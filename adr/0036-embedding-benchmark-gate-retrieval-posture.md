# ADR-0036: The embedding benchmark gate decides the default model and the retrieval posture

## Decision

The embedding default ships only if the benchmark gate passes, and the gate makes the retrieval-layer decision ADR-0013 deferred to it: cross-lingual recall from the secondary track to the primary one, and monolingual recall within the primary track, over the real sources. The winning candidate is what the embedder role holds, and the committed report carries the numbers; which role holds which chain is the live role map's business, never this record's. What "passes" means is the harness's contract — its floors are code, not prose.

The retrieval posture is **primary-only serving with the fallback track retained**: the primary track serves retrieval, and the fallback column stays built and switchable without re-embedding if real-user paraphrase recall ever justifies a fusion posture.

The expansion micro-task — given a glossary slice and an Indonesian query, does the router pick the correct Arabic expansion term? — is scored under a strict distractor-aware contract: any distractor pick alongside the expected term fails the case, and a parse error always fails. The task carries no gate floor, so it does not affect the go decision.

## Why

Self-retrieval probes have a ceiling that recall cannot see: the relevant document ranks high because the query text **is** a corpus entry, so a saturated recall figure is the expected outcome for a strong model rather than evidence of quality. The discriminating statistic is therefore the ranking statistic on the cross-lingual direction, and the default is retained on three grounds together — equal gate pass, equal-or-better cross-lingual ranking, and zero re-embedding cost, because the corpus is already embedded in its space while adopting a challenger means a clean-slate re-embed.

Rejected: a full-corpus run, unnecessary for a recall gate when a deterministic stratified subset bounds the estimate tightly and keeps re-runs comparable; a separate query-embedding pass, because self-retrieval probes reuse the corpus vectors and measure the same alignment for half the spend.

## Consequences

- Corpus-scale ingestion may proceed: this is the gate it waited on.
- The bench resolves each candidate alone from a bench-only candidate role through the same provider seam, never behind a fallback chain that could silently substitute another model, and its subset is deterministic so re-runs stay comparable.
- The expansion micro-task's figure feeds the terminology graph's consumption design qualitatively; the value belongs to the committed report, not to this record.
- **Revisit when** real-user paraphrase recall shows the primary track alone is insufficient and a fusion posture is wanted, or a new embedding candidate clears the same gate.
