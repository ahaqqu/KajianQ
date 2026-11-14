# Router benchmark report

Generated offline from the committed samples (`benchmarks/routing/samples/`) and run files (`benchmarks/routing/runs/`) at 2026-11-14T00:47:48.482Z — never hand-edited. Gate floors (ADR-0042's, applied per case): overall ≥ 0.85 AND every language ≥ 0.75 (≥ 3 scored cases per language); an arm that aborts is never a pass.

## Samples

- Seal **v1** (created 2026-11-13T23:40:28Z): **25** routing cases across ar (8), en (8), id (9).
- Fixture `router-bench-v0` (v0-draft); cases pinned at `sha256:e06d9a040a7bc2eecbb58fdfd523d9a95e4e142f44e0f80e2886bbb64378316e`.
- The seal covers the case fixture only. Each run file additionally pins the router prompt-wording hash it measured (promptsSha256), so a wording change after this seal is visible per run without re-sealing the cases.
- Cases assert the classification fields the router's own vocabulary narrows (intent always; category and needsPrinciple where unambiguous); the deterministic decomposition layer is never scored — only the model's reply is.
- A re-seal (any byte of cases.json changed) bumps version and archives runs/ to superseded/v<n>/ — the store refuses a run whose cases hash does not match the committed seal, so staleness is loud, never silent.

## Arms

| Model                          | Run file                                                    | Scored | Accuracy | ar                                                                                                                                                                                                                                                                                                                                                                    | en                                      | id       | Gate                     | Cost                                        | p50 latency | Finished                 |
| ------------------------------ | ----------------------------------------------------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------- | ------------------------ | ------------------------------------------- | ----------- | ------------------------ |
| `deepseek/deepseek-v4.1-flash` | `benchmarks/routing/runs/deepseek-deepseek-v4-1-flash.json` | 25/25  | 56.0%    | ar 62.5%                                                                                                                                                                                                                                                                                                                                                              | en 50.0%                                | id 55.6% | **fail**                 | 25968 µUSD total (budget bookkeeping 89387) | 3137 ms     | 2026-11-14T00:37:29.296Z |
| `google/gemini-3.8-flash`      | `benchmarks/routing/runs/google-gemini-3-8-flash.json`      | 25/25  | 64.0%    | ar 75.0%                                                                                                                                                                                                                                                                                                                                                              | en 50.0%                                | id 66.7% | **fail**                 | 63419 µUSD total                            | 5065 ms     | 2026-11-14T00:35:46.820Z |
| `openai/gpt-5-nano`            | `benchmarks/routing/runs/openai-gpt-5-nano.json`            | 25/25  | 48.0%    | ar 62.5%                                                                                                                                                                                                                                                                                                                                                              | en 25.0%                                | id 55.6% | **fail**                 | 28202 µUSD total                            | 16590 ms    | 2026-11-14T00:47:48.480Z |
| `qwen/qwen3.7-flash`           | `benchmarks/routing/runs/qwen-qwen3-7-flash.json`           | 0/25   | —        | **fail** ⚠ aborted (/chat/completions failed: HTTP 404: {"error":{"message":"0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons (an endpoint may have matched multiple reasons):\nZDR violation (account settings): 1 endpoint excluded; configurable at https://openroute) | 0 µUSD total (budget bookkeeping 91479) | —        | 2026-11-14T00:40:06.630Z |
| `z-ai/glm-5.3-flash`           | `benchmarks/routing/runs/z-ai-glm-5-3-flash.json`           | 25/25  | 52.0%    | ar 50.0%                                                                                                                                                                                                                                                                                                                                                              | en 50.0%                                | id 55.6% | **fail**                 | 2092 µUSD total (budget bookkeeping 91479)  | 5282 ms     | 2026-11-14T00:40:06.565Z |

Accuracy, per-language accuracy and the gate verdict are recomputed from each run's records; the run's own totals are never trusted. Cost is the sum of per-case `costMicroUsd`; p50 latency covers the records that carry one. A run that aborts keeps its partial records and names the failure — it is evidence, never a gate result.

## Misses

- `deepseek/deepseek-v4.1-flash` (11):
  - `rt-id-01` (id): expected `{"intent":"ruling","category":"fikih","needsPrinciple":false}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["yusr","masyaqqah","dharar"]}`
  - `rt-id-03` (id): expected `{"intent":"comparison","category":"fikih","needsPrinciple":false}`, got `{"intent":"comparison","category":"fikih","needsPrinciple":true,"principleTags":["yusr","rahmah","masyaqqah"]}`
  - `rt-id-05` (id): expected `{"intent":"aqidah","category":"aqidah","needsPrinciple":false}`, got `{"intent":"factual","category":"aqidah","needsPrinciple":false,"principleTags":[]}`
  - `rt-id-07` (id): expected `{"intent":"analogy","category":"fikih","needsPrinciple":true}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["masyaqqah","yusr","rahmah"]}`
  - `rt-en-01` (en): expected `{"intent":"ruling","category":"fikih","needsPrinciple":false}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["yusr","rahmah","masyaqqah"]}`
  - `rt-en-03` (en): expected `{"intent":"comparison","category":"fikih","needsPrinciple":false}`, got `{"intent":"comparison","category":"fikih","needsPrinciple":true,"principleTags":["yusr","rahmah","masyaqqah"]}`
  - `rt-en-05` (en): expected `{"intent":"aqidah","category":"aqidah","needsPrinciple":false}`, got `{"intent":"factual","category":"aqidah","needsPrinciple":false,"principleTags":[]}`
  - `rt-en-08` (en): expected `{"intent":"analogy","category":"fikih","needsPrinciple":true}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["masyaqqah","dharar"]}`
  - `rt-ar-01` (ar): expected `{"intent":"ruling","category":"fikih","needsPrinciple":false}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["yusr","rahmah","masyaqqah"]}`
  - `rt-ar-03` (ar): expected `{"intent":"comparison","category":"fikih","needsPrinciple":false}`, got `{"intent":"comparison","category":"fikih","needsPrinciple":true,"principleTags":["yusr","rahmah","masyaqqah"]}`
  - `rt-ar-05` (ar): expected `{"intent":"aqidah","category":"aqidah","needsPrinciple":false}`, got `{"intent":"factual","category":"aqidah","needsPrinciple":false,"principleTags":[]}`
- `google/gemini-3.8-flash` (9):
  - `rt-id-01` (id): expected `{"intent":"ruling","category":"fikih","needsPrinciple":false}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["masyaqqah","yusr"]}`
  - `rt-id-03` (id): expected `{"intent":"comparison","category":"fikih","needsPrinciple":false}`, got `{"intent":"comparison","category":"fikih","needsPrinciple":true,"principleTags":["yusr","masyaqqah"]}`
  - `rt-id-07` (id): expected `{"intent":"analogy","category":"fikih","needsPrinciple":true}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["masyaqqah","yusr"]}`
  - `rt-en-01` (en): expected `{"intent":"ruling","category":"fikih","needsPrinciple":false}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["masyaqqah","yusr"]}`
  - `rt-en-02` (en): expected `{"intent":"ruling","category":"fikih","needsPrinciple":true}`, got `{"intent":"factual","category":"fikih","needsPrinciple":true,"principleTags":["dharar"]}`
  - `rt-en-03` (en): expected `{"intent":"comparison","category":"fikih","needsPrinciple":false}`, got `{"intent":"comparison","category":"fikih","needsPrinciple":true,"principleTags":["yusr","masyaqqah"]}`
  - `rt-en-08` (en): expected `{"intent":"analogy","category":"fikih","needsPrinciple":true}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["masyaqqah","yusr"]}`
  - `rt-ar-01` (ar): expected `{"intent":"ruling","category":"fikih","needsPrinciple":false}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["masyaqqah","yusr"]}`
  - `rt-ar-03` (ar): expected `{"intent":"comparison","category":"fikih","needsPrinciple":false}`, got `{"intent":"comparison","category":"fikih","needsPrinciple":true,"principleTags":["yusr","masyaqqah"]}`
- `openai/gpt-5-nano` (13):
  - `rt-id-01` (id): expected `{"intent":"ruling","category":"fikih","needsPrinciple":false}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["yusr","rahmah","masyaqqah"]}`
  - `rt-id-03` (id): expected `{"intent":"comparison","category":"fikih","needsPrinciple":false}`, got `{"intent":"comparison","category":"fikih","needsPrinciple":true,"principleTags":["yusr","rahmah","masyaqqah"]}`
  - `rt-id-05` (id): expected `{"intent":"aqidah","category":"aqidah","needsPrinciple":false}`, got `{"intent":"factual","category":"aqidah","needsPrinciple":true,"principleTags":["rahmah","yusr"]}`
  - `rt-id-07` (id): expected `{"intent":"analogy","category":"fikih","needsPrinciple":true}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["yusr","rahmah","masyaqqah"]}`
  - `rt-en-01` (en): expected `{"intent":"ruling","category":"fikih","needsPrinciple":false}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["yusr","rahmah","masyaqqah"]}`
  - `rt-en-03` (en): expected `{"intent":"comparison","category":"fikih","needsPrinciple":false}`, got `{"intent":"comparison","category":"fikih","needsPrinciple":true,"principleTags":["yusr","masyaqqah","dharar"]}`
  - `rt-en-04` (en): expected `{"intent":"history","category":"sejarah"}`, got `{"intent":"factual","category":"sejarah","needsPrinciple":false,"principleTags":[]}`
  - `rt-en-05` (en): expected `{"intent":"aqidah","category":"aqidah","needsPrinciple":false}`, got `{"intent":"aqidah","category":"aqidah","needsPrinciple":true,"principleTags":["rahmah","yusr"]}`
  - `rt-en-06` (en): expected `{"intent":"factual","category":"hadith","needsPrinciple":false}`, got `{"intent":"factual","category":"hadith","needsPrinciple":true,"principleTags":[]}`
  - `rt-en-08` (en): expected `{"intent":"analogy","category":"fikih","needsPrinciple":true}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["yusr","rahmah","masyaqqah"]}`
  - `rt-ar-01` (ar): expected `{"intent":"ruling","category":"fikih","needsPrinciple":false}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["yusr","rahmah","dharar"]}`
  - `rt-ar-03` (ar): expected `{"intent":"comparison","category":"fikih","needsPrinciple":false}`, got `{"intent":"comparison","category":"fikih","needsPrinciple":true,"principleTags":["yusr","rahmah","masyaqqah"]}`
  - `rt-ar-05` (ar): expected `{"intent":"aqidah","category":"aqidah","needsPrinciple":false}`, got `{"intent":"factual","category":"aqidah","needsPrinciple":true,"principleTags":["rahmah","yusr","dharar"]}`
- `qwen/qwen3.7-flash`: none.
- `z-ai/glm-5.3-flash` (12):
  - `rt-id-01` (id): expected `{"intent":"ruling","category":"fikih","needsPrinciple":false}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["yusr","rahmah","masyaqqah"]}`
  - `rt-id-03` (id): expected `{"intent":"comparison","category":"fikih","needsPrinciple":false}`, got `{"intent":"comparison","category":"fikih","needsPrinciple":true,"principleTags":["yusr","masyaqqah","rahmah"]}`
  - `rt-id-05` (id): expected `{"intent":"aqidah","category":"aqidah","needsPrinciple":false}`, got `{"intent":"factual","category":"aqidah","needsPrinciple":false,"principleTags":[]}`
  - `rt-id-07` (id): expected `{"intent":"analogy","category":"fikih","needsPrinciple":true}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["masyaqqah","yusr","rahmah"]}`
  - `rt-en-01` (en): expected `{"intent":"ruling","category":"fikih","needsPrinciple":false}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["yusr","rahmah","masyaqqah"]}`
  - `rt-en-03` (en): expected `{"intent":"comparison","category":"fikih","needsPrinciple":false}`, got `{"intent":"comparison","category":"fikih","needsPrinciple":true,"principleTags":["yusr","masyaqqah"]}`
  - `rt-en-05` (en): expected `{"intent":"aqidah","category":"aqidah","needsPrinciple":false}`, got `{"intent":"factual","category":"aqidah","needsPrinciple":false,"principleTags":[]}`
  - `rt-en-08` (en): expected `{"intent":"analogy","category":"fikih","needsPrinciple":true}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["masyaqqah","yusr","rahmah"]}`
  - `rt-ar-01` (ar): expected `{"intent":"ruling","category":"fikih","needsPrinciple":false}`, got `{"intent":"ruling","category":"fikih","needsPrinciple":true,"principleTags":["yusr","masyaqqah","dharar"]}`
  - `rt-ar-02` (ar): expected `{"intent":"ruling","category":"fikih","needsPrinciple":true}`, got `{"intent":"analogy","category":"fikih","needsPrinciple":true,"principleTags":["dharar","rahmah"]}`
  - `rt-ar-03` (ar): expected `{"intent":"comparison","category":"fikih","needsPrinciple":false}`, got `{"intent":"comparison","category":"fikih","needsPrinciple":true,"principleTags":["yusr","rahmah"]}`
  - `rt-ar-08` (ar): expected `{"intent":"history","category":"sejarah"}`, got `{"intent":"factual","category":"sejarah","needsPrinciple":false,"principleTags":[]}`

## Selection

No arm passes the gate at this seal.

Adoption is a serving-chain config change made by a reviewed PR; this report supplies evidence and never switches a serving row by itself.
