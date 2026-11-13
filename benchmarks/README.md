# Model benchmark store — decision bench (append-only)

**Status: v1 framework + the sealed decision samples (21 cases, 3 languages,
unmeasured at this seal).** This directory is the KajianQ model-benchmark
store: frozen source data, append-only per-model run files, and an offline
report derived from the committed files — the same shape as the
[RumaQ-pipeline](https://github.com/ahaqqu/RumaQ-pipeline) `benchmarks/`
framework, adapted to KajianQ's decision-model gate (ADR-0042).

The point of the design is **additive runs**: benchmarking a new candidate
costs exactly one run file plus one re-report. Committed arms are never
re-run, never re-scored against later data, and never silently replaced.

## Layout

| Path                             | What it is                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `decisions/samples/cases.json`   | The sealed case fixture — the full source data, committed bytes (21 multilingual relevance/rerank/citation cases, `decision-bench-v0`) |
| `decisions/samples/version.json` | The seal: version, counts, languages, the cases sha256 pin, and the notes that make re-seals honest                                    |
| `decisions/runs/`                | Append-only run files, one per candidate arm, named by the model's slug                                                                |
| `decisions/probes/`              | One-call probe evidence (endpoint acceptance, rolling-id checks)                                                                       |
| `decisions/superseded/`          | Frozen results that predate the committed seal or an earlier one — history, never scored                                               |
| `decisions/report.md`            | The generated report — derived offline from the committed files, **never hand-edited**                                                 |

## Invariants

1. **Samples are committed bytes, sealed.** The seal's `hashes.cases` must
   match `cases.json` on disk; the runner verifies both before any spend, and
   the seal's counts must match the parsed fixture. A mismatch fails loudly.
2. **A run file is written once.** An overwrite is refused without
   `--force`; a forced re-run replaces its own committed measurement in the
   same PR that says so.
3. **Every run pins what it measured**: the samples seal (version + cases
   hash), the prompt-wording hash (`promptsSha256`), the budget, the gate
   floors, and one record per case (expected, got, passed, metered cost).
   The loader refuses a run whose pin does not match the committed seal —
   archive it under `superseded/` or re-run at the current seal.
4. **The report is derived, never edited.** Accuracy, per-language accuracy,
   and the gate verdict are recomputed from each run's records; a run's own
   totals are never trusted. Regenerate it keyless and offline:
   `bun run eval:decision-bench -- --report-only`.
5. **A re-seal archives.** Any byte of `cases.json` changed bumps the seal
   version and moves the runs it invalidated to `superseded/v<n>/` in the
   same PR — the old measurement stays frozen with the generation it
   measured.
6. **The gate decides nothing by itself.** Floors (ADR-0042): overall ≥ 0.85
   AND every language ≥ 0.75 (≥ 3 scored cases per language). Adoption is a
   `benchAdoption` config change made by a reviewed PR; the report supplies
   evidence, never a switch.

## Running

```sh
bun run eval:decision-bench                     # all keyed decision candidates
bun run eval:decision-bench -- --model 'perplexity/pplx-decider-v1.3'   # one arm (additive)
bun run eval:decision-bench -- --force --model '~typesafe/jev-latest'   # deliberate re-run
bun run eval:decision-bench -- --report-only    # regenerate report.md — no key, no network
```

`OPENROUTER_API_KEY` absent ⇒ the run reports NOT RUN and exits 0 (CI
posture). `EVAL_BUDGET_MICRO_USD` caps the spend. Each invocation appends
one run file per candidate it actually ran and regenerates the report.

## Data provenance

The case fixture's passages are verbatim from commit-safe sources — Bukhari
hadith 1 & 2 and Abu Dawud 1 (fawazahmed0/hadith-api, The Unlicense) and
Quran Arabic from the Tanzil Uthmani edition (verbatim distribution
permitted with attribution) — see the fixture's `$comment` and
`NOTICES/DATASETS.md`.
