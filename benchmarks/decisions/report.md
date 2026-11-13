# Decision benchmark report

Generated offline from the committed samples (`benchmarks/decisions/samples/`) and run files (`benchmarks/decisions/runs/`) at 2026-11-13T23:15:42.740Z — never hand-edited. Gate floors (ADR-0042): overall ≥ 0.85 AND every language ≥ 0.75 (≥ 3 scored cases per language); an arm that aborts is never a pass.

## Samples

- Seal **v1** (created 2026-11-13T23:04:04Z): **21** cases — 12 relevance, 3 rerank, 6 citation — across ar (7), en (7), id (7).
- Fixture `decision-bench-v0` (v0-draft); cases pinned at `sha256:830df54ff7e62b1d56e9ae07d47f2bab04606a6fa9b8ce33a08f30870e954394`.
- The seal covers the case fixture only. Each run file additionally pins the prompt-wording hash it measured (promptsSha256), so a wording change after this seal is visible per run without re-sealing the cases.
- The result under superseded/pre-seal/ (jev-1.13.0, 2026-09-18, chat-wire era) predates the seal: it pins nothing, is frozen history, and the report never scores it.
- A re-seal (any byte of cases.json changed) bumps version and archives runs/ to superseded/v<n>/ — the store refuses a run whose cases hash does not match the committed seal, so staleness is loud, never silent.

## Arms

No runs at the committed seal yet. Each keyed `eval:decision-bench` invocation appends one run file per candidate here; adding a model never re-runs the others.

## Selection

No arm passes the gate at this seal.

Adoption is a `benchAdoption` config change made by a reviewed PR; this report supplies evidence and never switches a serving row by itself.

## Superseded

1 frozen result(s) under `superseded/` predate the committed seal or an earlier one — kept as history, never scored.
