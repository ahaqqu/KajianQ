# Embedding benchmark report

Generated offline from the committed samples (`benchmarks/embeddings/samples/`) and run files (`benchmarks/embeddings/runs/`) at 2026-11-14T05:54:06.073Z — never hand-edited. Gate floors (ADR-0013): cross-lingual `secondary→primary` recall@10 ≥ 0.7 AND monolingual `primary→primary` recall@10 ≥ 0.75; an arm that aborts is never a pass.

## Samples

- Seal **v1** (created 2026-11-14T07:05:00Z): **400** retrieval probes — 200 cross-lingual, 200 monolingual — plus **12** expansion cases.
- Fixtures `embed-bench-probes-v0` (canonical) + `expansion-cases-v0` (canonical); probes pinned at `sha256:826bfc0dfb9d8f1ebea4841909808e68003d8432be3c356957569a66e8a18bff`, expansion at `sha256:98efedc5a432c9574ebd03ed5544fbffc9c461293259e7f54a381b7a66e13c19`; corpus fingerprint `fnv1a64:478dc7ce1bae2d30:1500`.
- The corpus fingerprint is the probe fixture's own pin: the probes were authored against a deterministic stratified subset of the real sources (1500 docs), and the loader refuses a probe fixture whose fingerprint disagrees with the corpus a run builds — so a run here measures the same bytes the seal pins.
- The result under superseded/pre-store/ (2026-09-10, free-tier era, two embedding arms + the expansion micro-task) predates the store: it was measured at this same corpus fingerprint but pins no sample hashes, so it is frozen history and the report never scores it.
- A re-seal (any byte of probes.json or expansion-cases.json changed) bumps version and archives runs/ to superseded/v<n>/ — the store refuses a run whose sample hashes or corpus fingerprint do not match the committed seal, so staleness is loud, never silent.
- Run files pin the sample hashes and the corpus fingerprint but not the expansion prompt wording (no wording identity exists yet); a prompt-wording change is a re-seal signal for the expansion arm of the gate.
- Embedding spend is metered per batch into the run's budget total; only the expansion records carry per-call cost records (one call = one case there).

## Arms

| Model                         | Run file                                                      | secondary→primary | primary→primary | expansion | Gate     | Cost        | Finished                 |
| ----------------------------- | ------------------------------------------------------------- | ----------------- | --------------- | --------- | -------- | ----------- | ------------------------ |
| `google/gemini-embedding-001` | `benchmarks/embeddings/runs/google-gemini-embedding-001.json` | 100.0% (1.000)    | 100.0% (1.000)  | 41.7%     | **pass** | 113737 µUSD | 2026-11-14T00:41:08.992Z |
| `google/gemini-embedding-2`   | `benchmarks/embeddings/runs/google-gemini-embedding-2.json`   | 100.0% (0.998)    | 100.0% (1.000)  | 50.0%     | **pass** | 150297 µUSD | 2026-11-14T00:46:40.955Z |
| `perplexity/pplx-embed-v1-4b` | `benchmarks/embeddings/runs/perplexity-pplx-embed-v1-4b.json` | 100.0% (0.982)    | 100.0% (1.000)  | 50.0%     | **pass** | 32258 µUSD  | 2026-11-14T01:23:24.046Z |
| `qwen/qwen3-embedding-8b`     | `benchmarks/embeddings/runs/qwen-qwen3-embedding-8b.json`     | 100.0% (0.993)    | 100.0% (1.000)  | 41.7%     | **pass** | 15231 µUSD  | 2026-11-14T00:55:46.237Z |

Direction cells show recall@10 with MRR in parentheses, recomputed from each run's records; the run's own totals are never trusted. The expansion cell is the mean pass rate over the run's expansion records. Cost is the run's budget bookkeeping (its total metered spend); per-call cost records cover the expansion calls. A run that aborts keeps its partial records and names the failure — it is evidence, never a gate result.

## Misses

- `google/gemini-embedding-001` (7):
  - `expansion/exp-003`: expected `الفِرْدَوْس`, got `الفِرْدَوْس, الجَنَّة`
  - `expansion/exp-004`: expected `زَكَاةُ الفِطْر`, got `زَكَاةُ الفِطْر, الزَّكَاة`
  - `expansion/exp-006`: expected `الفِدْيَة`, got `الصِّيَام, القَضَاء`
  - `expansion/exp-009`: expected `الحَجّ`, got `الحَجّ, الإِحْرَام`
  - `expansion/exp-010`: expected `الرِّزْق`, got `الرِّزْق, الحَلَال`
  - `expansion/exp-011`: expected `الطَّلَاق`, got `الطَّلَاق, النِّكَاح`
  - `expansion/exp-012`: expected `لَيْلَةُ القَدْر`, got `لَيْلَةُ القَدْر, رَمَضَان`
- `google/gemini-embedding-2` (6):
  - `expansion/exp-003`: expected `الفِرْدَوْس`, got `الفِرْدَوْس, الجَنَّة`
  - `expansion/exp-004`: expected `زَكَاةُ الفِطْر`, got `زَكَاةُ الفِطْر, الزَّكَاة`
  - `expansion/exp-006`: expected `الفِدْيَة`, got `الصِّيَام, القَضَاء`
  - `expansion/exp-009`: expected `الحَجّ`, got `الحَجّ, الإِحْرَام`
  - `expansion/exp-010`: expected `الرِّزْق`, got `الرِّزْق, الحَلَال`
  - `expansion/exp-011`: expected `الطَّلَاق`, got `الطَّلَاق, النِّكَاح`
- `perplexity/pplx-embed-v1-4b` (6):
  - `expansion/exp-001`: expected `الوُضُوء`, got `الوُضُوء, التَّيَمُّم`
  - `expansion/exp-003`: expected `الفِرْدَوْس`, got `الفِرْدَوْس, الجَنَّة`
  - `expansion/exp-006`: expected `الفِدْيَة`, got `الصِّيَام, القَضَاء`
  - `expansion/exp-009`: expected `الحَجّ`, got `الحَجّ, الإِحْرَام`
  - `expansion/exp-010`: expected `الرِّزْق`, got `الرِّزْق, الحَلَال`
  - `expansion/exp-011`: expected `الطَّلَاق`, got `الطَّلَاق, النِّكَاح`
- `qwen/qwen3-embedding-8b` (7):
  - `expansion/exp-001`: expected `الوُضُوء`, got `الوُضُوء, التَّيَمُّم`
  - `expansion/exp-003`: expected `الفِرْدَوْس`, got `الفِرْدَوْس, الجَنَّة`
  - `expansion/exp-005`: expected `صَلَاةُ الكُسُوف`, got `صَلَاةُ الكُسُوف, الصَّلَاة`
  - `expansion/exp-006`: expected `الفِدْيَة`, got `الصِّيَام, القَضَاء`
  - `expansion/exp-009`: expected `الحَجّ`, got `الحَجّ, الإِحْرَام`
  - `expansion/exp-010`: expected `الرِّزْق`, got `الرِّزْق, الحَلَال`
  - `expansion/exp-011`: expected `الطَّلَاق`, got `الطَّلَاق, النِّكَاح`

## Selection

Gate-passing arms at this seal: `google/gemini-embedding-001`, `google/gemini-embedding-2`, `perplexity/pplx-embed-v1-4b`, `qwen/qwen3-embedding-8b`.

Adoption is an `embedder` role change made by a reviewed PR; this report supplies evidence and never switches a serving row by itself.

## Superseded

1 frozen result(s) under `superseded/` predate the committed seal or an earlier one — kept as history, never scored.
