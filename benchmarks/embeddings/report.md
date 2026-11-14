# Embedding benchmark report

Generated offline from the committed samples (`benchmarks/embeddings/samples/`) and run files (`benchmarks/embeddings/runs/`) at 2026-11-14T00:07:34.046Z — never hand-edited. Gate floors (ADR-0013): cross-lingual `secondary→primary` recall@10 ≥ 0.7 AND monolingual `primary→primary` recall@10 ≥ 0.75; an arm that aborts is never a pass.

## Samples

- Seal **v1** (created 2026-11-14T07:05:00Z): **400** retrieval probes — 200 cross-lingual, 200 monolingual — plus **12** expansion cases.
- Fixtures `embed-bench-probes-v0` (canonical) + `expansion-cases-v0` (canonical); probes pinned at `sha256:826bfc0dfb9d8f1ebea4841909808e68003d8432be3c356957569a66e8a18bff`, expansion at `sha256:98efedc5a432c9574ebd03ed5544fbffc9c461293259e7f54a381b7a66e13c19`; corpus fingerprint `fnv1a64:478dc7ce1bae2d30:1500`.
- The corpus fingerprint is the probe fixture's own pin: the probes were authored against a deterministic stratified subset of the real sources (1500 docs), and the loader refuses a probe fixture whose fingerprint disagrees with the corpus a run builds — so a run here measures the same bytes the seal pins.
- The result under superseded/pre-store/ (2026-09-10, free-tier era, two embedding arms + the expansion micro-task) predates the store: it was measured at this same corpus fingerprint but pins no sample hashes, so it is frozen history and the report never scores it.
- A re-seal (any byte of probes.json or expansion-cases.json changed) bumps version and archives runs/ to superseded/v<n>/ — the store refuses a run whose sample hashes or corpus fingerprint do not match the committed seal, so staleness is loud, never silent.
- Run files pin the sample hashes and the corpus fingerprint but not the expansion prompt wording (no wording identity exists yet); a prompt-wording change is a re-seal signal for the expansion arm of the gate.
- Embedding spend is metered per batch into the run's budget total; only the expansion records carry per-call cost records (one call = one case there).

## Arms

No runs at the committed seal yet. Each keyed `eval:embed-bench` invocation appends one run file per candidate here; adding a model never re-runs the others.

## Selection

No arm passes the gate at this seal.

Adoption is an `embedder` role change made by a reviewed PR; this report supplies evidence and never switches a serving row by itself.

## Superseded

1 frozen result(s) under `superseded/` predate the committed seal or an earlier one — kept as history, never scored.
