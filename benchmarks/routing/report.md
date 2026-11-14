# Router benchmark report

Generated offline from the committed samples (`benchmarks/routing/samples/`) and run files (`benchmarks/routing/runs/`) at 2026-11-14T03:17:46.129Z — never hand-edited. Gate floors (ADR-0042's, applied per case): overall ≥ 0.85 AND every language ≥ 0.75 (≥ 3 scored cases per language); an arm that aborts is never a pass.

## Samples

- Seal **v2** (created 2026-11-14T02:20:00Z): **25** routing cases across ar (8), en (8), id (9).
- Fixture `router-bench-v0` (v0-draft); cases pinned at `sha256:bd1eb9aa3543768f1f596bb5f907a3bb5500b2366ee42a75795987135bc30262`.
- The seal covers the case fixture only. Each run file additionally pins the router prompt-wording hash it measured (promptsSha256), so a wording change after this seal is visible per run without re-sealing the cases.
- v2 drops the needsPrinciple/principleTags assertions with the live principle routing itself: the reply contract no longer carries the fields, so asserting them would score a field no reply can carry. v1 (with the principle assertions) and its four committed arm runs are archived under superseded/v1/.
- Cases assert the classification fields the router's own vocabulary narrows (intent always; category where unambiguous); the deterministic decomposition layer is never scored — only the model's reply is.
- A re-seal (any byte of cases.json changed) bumps version and archives runs/ to superseded/v<n>/ — the store refuses a run whose cases hash does not match the committed seal, so staleness is loud, never silent.

## Arms

| Model                          | Run file                                                    | Scored | Accuracy | ar        | en       | id        | Gate     | Cost                                         | p50 latency | Finished                 |
| ------------------------------ | ----------------------------------------------------------- | ------ | -------- | --------- | -------- | --------- | -------- | -------------------------------------------- | ----------- | ------------------------ |
| `deepseek/deepseek-v4.1-flash` | `benchmarks/routing/runs/deepseek-deepseek-v4-1-flash.json` | 25/25  | 84.0%    | ar 87.5%  | en 75.0% | id 88.9%  | **fail** | 18222 µUSD total (budget bookkeeping 73819)  | 2099 ms     | 2026-11-14T03:04:13.549Z |
| `google/gemini-3.8-flash`      | `benchmarks/routing/runs/google-gemini-3-8-flash.json`      | 25/25  | 96.0%    | ar 100.0% | en 87.5% | id 100.0% | **pass** | 55597 µUSD total                             | 4457 ms     | 2026-11-14T03:03:10.691Z |
| `openai/gpt-5-nano`            | `benchmarks/routing/runs/openai-gpt-5-nano.json`            | 25/25  | 80.0%    | ar 87.5%  | en 75.0% | id 77.8%  | **fail** | 27265 µUSD total (budget bookkeeping 102719) | 25941 ms    | 2026-11-14T03:17:46.127Z |
| `z-ai/glm-5.3-flash`           | `benchmarks/routing/runs/z-ai-glm-5-3-flash.json`           | 25/25  | 80.0%    | ar 75.0%  | en 75.0% | id 88.9%  | **fail** | 1635 µUSD total (budget bookkeeping 75454)   | 4467 ms     | 2026-11-14T03:06:20.694Z |

Accuracy, per-language accuracy and the gate verdict are recomputed from each run's records; the run's own totals are never trusted. Cost is the sum of per-case `costMicroUsd`; p50 latency covers the records that carry one. A run that aborts keeps its partial records and names the failure — it is evidence, never a gate result.

## Misses

- `deepseek/deepseek-v4.1-flash` (4):
  - `rt-id-07` (id): expected `{"intent":"analogy","category":"fikih"}`, got `{"intent":"ruling","category":"fikih"}`
  - `rt-en-05` (en): expected `{"intent":"aqidah","category":"aqidah"}`, got `{"intent":"factual","category":"aqidah"}`
  - `rt-en-08` (en): expected `{"intent":"analogy","category":"fikih"}`, got `{"intent":"ruling","category":"fikih"}`
  - `rt-ar-05` (ar): expected `{"intent":"aqidah","category":"aqidah"}`, got `{"intent":"factual","category":"aqidah"}`
- `google/gemini-3.8-flash` (1):
  - `rt-en-08` (en): expected `{"intent":"analogy","category":"fikih"}`, got `{"intent":"ruling","category":"fikih"}`
- `openai/gpt-5-nano` (5):
  - `rt-id-05` (id): expected `{"intent":"aqidah","category":"aqidah"}`, got `{"intent":"factual","category":"aqidah"}`
  - `rt-id-07` (id): expected `{"intent":"analogy","category":"fikih"}`, got `{"intent":"ruling","category":"fikih"}`
  - `rt-en-05` (en): expected `{"intent":"aqidah","category":"aqidah"}`, got `{"intent":"factual","category":"aqidah"}`
  - `rt-en-08` (en): expected `{"intent":"analogy","category":"fikih"}`, got `{"intent":"ruling","category":"fikih"}`
  - `rt-ar-07` (ar): expected `{"intent":"factual","category":"quran"}`, got `{"intent":"factual","category":"sejarah"}`
- `z-ai/glm-5.3-flash` (5):
  - `rt-id-07` (id): expected `{"intent":"analogy","category":"fikih"}`, got `{"intent":"ruling","category":"fikih"}`
  - `rt-en-05` (en): expected `{"intent":"aqidah","category":"aqidah"}`, got `{"intent":"factual","category":"aqidah"}`
  - `rt-en-08` (en): expected `{"intent":"analogy","category":"fikih"}`, got `{"intent":"ruling","category":"fikih"}`
  - `rt-ar-02` (ar): expected `{"intent":"ruling","category":"fikih"}`, got `{"intent":"factual","category":"fikih"}`
  - `rt-ar-08` (ar): expected `{"intent":"history","category":"sejarah"}`, got `{"intent":"factual","category":"sejarah"}`

## Selection

Gate-passing arms at this seal: `google/gemini-3.8-flash`.

Adoption is a serving-chain config change made by a reviewed PR; this report supplies evidence and never switches a serving row by itself.

## Superseded

5 frozen result(s) under `superseded/` predate the committed seal or an earlier one — kept as history, never scored.
