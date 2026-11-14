# Summarizer benchmark report

Generated offline from the committed samples (`benchmarks/summarization/samples/`) and run files (`benchmarks/summarization/runs/`) at 2026-11-14T00:23:05.650Z — never hand-edited. Gate floors (ADR-0042's, applied per case): overall ≥ 0.85 AND every language ≥ 0.75 (≥ 3 scored cases per language); an arm that aborts is never a pass. The gate scores only what is deterministic — format bounds and faithfulness grounding; theme quality stays the owner's call, made from the summaries printed below.

## Samples

- Seal **v1** (created 2026-11-13T23:40:28Z): **5** cases across id (5).
- Fixture `summarizer-bench-v0` (v0-draft); cases pinned at `sha256:dcc936e8451f1fbc835639ea406baa06266c035e5dfeb125e4d58d1082f06db4`.
- The seal covers the case fixture only. Each run file additionally pins the summarizer prompt-wording hash it measured (promptsSha256), so a wording change after this seal is visible per run without re-sealing the cases.
- The gate scores what is deterministic — format bounds and faithfulness grounding — and prints every summary; theme quality stays the owner's human call, made from the report's side-by-side artifacts.
- A re-seal (any byte of cases.json changed) bumps version and archives runs/ to superseded/v<n>/ — the store refuses a run whose cases hash does not match the committed seal, so staleness is loud, never silent.

## Arms

No runs at the committed seal yet. Each keyed `eval:summarizer-bench` invocation appends one run file per candidate here; adding a model never re-runs the others.

## Selection

No arm passes the gate at this seal.

Adoption is a serving-chain config change made by a reviewed PR; this report supplies evidence and never switches a serving row by itself.
