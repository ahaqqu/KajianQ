# ADR-0036: The embedding benchmark gate decides the default model and the retrieval posture

## Decision

The embedding default ships only if the benchmark gate passes, and the gate makes the retrieval-layer decision
ADR-0013 deferred to it: cross-lingual recall from the secondary (Indonesian) track to the primary (Arabic) track, and
monolingual recall within the primary track, over the real v1 sources. The winning candidate is what the `embedder`
role holds; the committed report carries every number, and which role holds which chain is the live role map's
business, never this record's.

The retrieval posture is **Arabic-only serving with the Indonesian fallback track retained**: the primary track serves
retrieval, and the fallback column stays built and switchable without re-embedding for a future fusion posture if
real-user paraphrase recall ever justifies it.

The expansion micro-task — given a glossary slice and an Indonesian query, does the router pick the correct Arabic
expansion term? — is scored under the strict distractor-aware contract: any distractor pick alongside the expected
term fails the case, a distractor identical to the expected term is ignored as a fixture-authoring slip, and a parse
error always fails. That contract is the intended posture; the recorded figure came from an earlier, lenient contract
and is not reproducible under this one. The task has no gate floor, so it does not affect the go decision.

## Why

Self-retrieval probes have a ceiling that recall cannot see: the relevant document ranks high because the query text
_is_ a corpus entry, so a saturated recall figure is the expected strong-model outcome rather than evidence of
quality. The discriminating statistic is therefore the ranking statistic on the cross-lingual direction, and the
default is retained on three grounds together — equal gate pass, equal-or-better cross-lingual ranking, and zero
re-embedding cost, because the corpus is already embedded in its space while adopting the challenger is a clean-slate
re-embed of an incompatible space.

Rejected: a full-corpus run, infeasible inside the free-tier item quota's wall-clock and unnecessary for a recall
gate, since a deterministic stratified subset preserving each source group's share bounds the estimate tightly and
keeps re-runs comparable; and a separate query-embedding pass, because self-retrieval probes reuse the corpus vectors
and measure the same alignment for half the spend.

The recorded expansion run is not re-scored retroactively — its picks include the contextual distractors the
consumption design blesses — and the next re-run, whose prompt asks for exactly the expected term, is the first
strict-contract measurement. That deferral is deliberate, not budgetary. The sharper test of natural-language
Indonesian user queries against the Arabic corpus arrives with the Golden Set runs against the live pipeline, which
exercise the full cross-lingual path including query expansion.

## Consequences

Kitab-scale ingestion may proceed: this is the gate it waited on. Spec currency: the spec's stale warning that the
embedding default was unproven is resolved by this record.

The bench resolves each candidate alone from the bench-only candidate role through the same provider seam, never
behind a fallback chain that could silently substitute another model, and its subset is deterministic so re-runs stay
comparable.

The expansion micro-task's figure still feeds ADR-0014's consumption design qualitatively, but the value belongs to
the committed report, not to this record.
