# Router benchmark report

Generated offline from the committed samples (`benchmarks/routing/samples/`) and run files (`benchmarks/routing/runs/`) at 2026-11-14T00:23:04.987Z — never hand-edited. Gate floors (ADR-0042's, applied per case): overall ≥ 0.85 AND every language ≥ 0.75 (≥ 3 scored cases per language); an arm that aborts is never a pass.

## Samples

- Seal **v1** (created 2026-11-13T23:40:28Z): **25** routing cases across ar (8), en (8), id (9).
- Fixture `router-bench-v0` (v0-draft); cases pinned at `sha256:e06d9a040a7bc2eecbb58fdfd523d9a95e4e142f44e0f80e2886bbb64378316e`.
- The seal covers the case fixture only. Each run file additionally pins the router prompt-wording hash it measured (promptsSha256), so a wording change after this seal is visible per run without re-sealing the cases.
- Cases assert the classification fields the router's own vocabulary narrows (intent always; category and needsPrinciple where unambiguous); the deterministic decomposition layer is never scored — only the model's reply is.
- A re-seal (any byte of cases.json changed) bumps version and archives runs/ to superseded/v<n>/ — the store refuses a run whose cases hash does not match the committed seal, so staleness is loud, never silent.

## Arms

No runs at the committed seal yet. Each keyed `eval:router-bench` invocation appends one run file per candidate here; adding a model never re-runs the others.

## Selection

No arm passes the gate at this seal.

Adoption is a serving-chain config change made by a reviewed PR; this report supplies evidence and never switches a serving row by itself.
