# Decision benchmark report

Generated offline from the committed samples (`benchmarks/decisions/samples/`) and run files (`benchmarks/decisions/runs/`) at 2026-11-14T05:54:04.001Z — never hand-edited. Gate floors (ADR-0042): overall ≥ 0.85 AND every language ≥ 0.75 (≥ 3 scored cases per language); an arm that aborts is never a pass.

## Samples

- Seal **v1** (created 2026-11-13T23:04:04Z): **21** cases — 12 relevance, 3 rerank, 6 citation — across ar (7), en (7), id (7).
- Fixture `decision-bench-v0` (v0-draft); cases pinned at `sha256:830df54ff7e62b1d56e9ae07d47f2bab04606a6fa9b8ce33a08f30870e954394`.
- The seal covers the case fixture only. Each run file additionally pins the prompt-wording hash it measured (promptsSha256), so a wording change after this seal is visible per run without re-sealing the cases.
- The result under superseded/pre-seal/ (jev-1.13.0, 2026-09-18, chat-wire era) predates the seal: it pins nothing, is frozen history, and the report never scores it.
- A re-seal (any byte of cases.json changed) bumps version and archives runs/ to superseded/v<n>/ — the store refuses a run whose cases hash does not match the committed seal, so staleness is loud, never silent.

## Arms

| Model                                   | Run file                                                               | Scored | Accuracy | ar        | en        | id        | Gate                                                                                               | Cost             | p50 latency | Finished                 |
| --------------------------------------- | ---------------------------------------------------------------------- | ------ | -------- | --------- | --------- | --------- | -------------------------------------------------------------------------------------------------- | ---------------- | ----------- | ------------------------ |
| `deepseek/deepseek-v4.1-flash`          | `benchmarks/decisions/runs/deepseek-deepseek-v4-1-flash.json`          | 12/21  | 100.0%   | ar 100.0% | en 100.0% | id 100.0% | **abort** ⚠ aborted (decision answer for "best" is malformed, out of range, or off the option set) | 2593 µUSD total  | 969 ms      | 2026-11-14T00:06:57.527Z |
| `google/gemini-3.8-flash`               | `benchmarks/decisions/runs/google-gemini-3-8-flash.json`               | 21/21  | 100.0%   | ar 100.0% | en 100.0% | id 100.0% | **pass**                                                                                           | 22509 µUSD total | 2711 ms     | 2026-11-14T00:01:23.013Z |
| `perplexity/pplx-decider-v1.2-20261016` | `benchmarks/decisions/runs/perplexity-pplx-decider-v1-2-20261016.json` | 21/21  | 100.0%   | ar 100.0% | en 100.0% | id 100.0% | **pass**                                                                                           | 97 µUSD total    | 568 ms      | 2026-11-14T00:06:35.505Z |
| `~typesafe/jev-latest`                  | `benchmarks/decisions/runs/typesafe-jev-latest.json`                   | 21/21  | 100.0%   | ar 100.0% | en 100.0% | id 100.0% | **pass**                                                                                           | 432 µUSD total   | 447 ms      | 2026-11-14T00:02:18.328Z |

Accuracy, per-language accuracy and the gate verdict are recomputed from each run's records; the run's own totals are never trusted. Cost is the sum of per-case `costMicroUsd`; p50 latency covers the records that carry one. A run that aborts keeps its partial records and names the failure — it is evidence, never a gate result.

## Misses

- `deepseek/deepseek-v4.1-flash`: none.
- `google/gemini-3.8-flash`: none.
- `perplexity/pplx-decider-v1.2-20261016`: none.
- `~typesafe/jev-latest`: none.

## Selection

Gate-passing arms at this seal: `google/gemini-3.8-flash`, `perplexity/pplx-decider-v1.2-20261016`, `~typesafe/jev-latest`.

Adoption is a serving-chain config change made by a reviewed PR; this report supplies evidence and never switches a serving row by itself.

## Superseded

1 frozen result(s) under `superseded/` predate the committed seal or an earlier one — kept as history, never scored.
