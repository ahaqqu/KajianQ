# Model benchmark store (append-only)

**Status: v1 framework + the sealed decision samples (21 cases, 3 languages),
the sealed embedding samples (400 probes in two directions + 12 expansion
cases), the sealed routing samples (25 cases, 3 languages), and the sealed
summarization samples (5 cases) — each bench's `report.md` carries its
measurement state.** This directory is
the KajianQ model-benchmark store: frozen source data, append-only per-model
run files, and an offline report derived from the committed files — the same
shape as the [RumaQ-pipeline](https://github.com/ahaqqu/RumaQ-pipeline)
`benchmarks/` framework, adapted to KajianQ's decision-model gate (ADR-0042),
its embedding gate (issue #9, ADR-0013/0014/0036), and the router and
ingest-summarizer gates over the same store discipline.

The point of the design is **additive runs**: benchmarking a new candidate
costs exactly one run file plus one re-report. Committed arms are never
re-run, never re-scored against later data, and never silently replaced.

## Layout

| Path                                      | What it is                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `decisions/samples/cases.json`            | The sealed case fixture — the full source data, committed bytes (21 multilingual relevance/rerank/citation cases, `decision-bench-v0`)     |
| `decisions/samples/version.json`          | The seal: version, counts, languages, the cases sha256 pin, and the notes that make re-seals honest                                        |
| `decisions/runs/`                         | Append-only run files, one per candidate arm, named by the model's slug                                                                    |
| `decisions/probes/`                       | One-call probe evidence (endpoint acceptance, rolling-id checks)                                                                           |
| `decisions/superseded/`                   | Frozen results that predate the committed seal or an earlier one — history, never scored                                                   |
| `decisions/report.md`                     | The generated report — derived offline from the committed files, **never hand-edited**                                                     |
| `embeddings/samples/probes.json`          | The sealed probe fixture — retrieval probes per direction with their relevant ids (`embed-bench-probes-v0`)                                |
| `embeddings/samples/expansion-cases.json` | The sealed expansion fixture — the ADR-0014 term-selection micro-task cases (`expansion-cases-v0`)                                         |
| `embeddings/samples/version.json`         | The seal: version, counts, both sha256 pins, the corpus fingerprint the probes pin, and the notes                                          |
| `embeddings/runs/`                        | Append-only run files, one per candidate arm, named by the model's slug                                                                    |
| `embeddings/probes/`                      | Probe evidence (one-call checks)                                                                                                           |
| `embeddings/superseded/`                  | Frozen results that predate the store or an earlier seal — history, never scored                                                           |
| `embeddings/report.md`                    | The generated report — derived offline from the committed files, **never hand-edited**                                                     |
| `routing/samples/cases.json`              | The sealed case fixture — the full source data, committed bytes (25 multilingual intent/category/needs-principle cases, `router-bench-v0`) |
| `routing/samples/version.json`            | The seal: version, counts, languages, the cases sha256 pin, and the notes                                                                  |
| `routing/runs/`                           | Append-only run files, one per candidate arm, named by the model's slug                                                                    |
| `routing/probes/`                         | One-call probe evidence (endpoint or reply-format checks)                                                                                  |
| `routing/superseded/`                     | Frozen results that predate the committed seal or an earlier one — history, never scored                                                   |
| `routing/report.md`                       | The generated report — derived offline from the committed files, **never hand-edited**                                                     |
| `summarization/samples/cases.json`        | The sealed case fixture — the full source data, committed bytes (5 ingest-summarizer cases over Arabic primary excerpts)                   |
| `summarization/samples/version.json`      | The seal: version, counts, languages, the cases sha256 pin, and the notes                                                                  |
| `summarization/runs/`                     | Append-only run files, one per candidate arm, named by the model's slug                                                                    |
| `summarization/probes/`                   | One-call probe evidence (prompt or reply-format checks)                                                                                    |
| `summarization/superseded/`               | Frozen results that predate the committed seal or an earlier one — history, never scored                                                   |
| `summarization/report.md`                 | The generated report — derived offline from the committed files, **never hand-edited**                                                     |

## Invariants

1. **Samples are committed bytes, sealed.** Each seal's hashes must match the
   sample files on disk (decision/routing/summarization: `cases.json`;
   embedding: `probes.json` + `expansion-cases.json`) and its counts must match
   the parsed fixtures — the
   embedding seal additionally pins the probe fixture's corpus fingerprint, and
   the probe loader refuses a corpus built at a different one. A mismatch fails
   loudly, before any spend.
2. **A run file is written once.** An overwrite is refused without
   `--force`; a forced re-run replaces its own committed measurement in the
   same PR that says so.
3. **Every run pins what it measured**: the samples seal (version + sample
   hashes, plus the corpus fingerprint for embeddings), the budget, the gate
   floors, and one record per probe/case (expected, got, passed; a cost
   record where one call = one case). The loader refuses a run whose pin does
   not match the committed seal — archive it under `superseded/` or re-run at
   the current seal.
4. **The report is derived, never edited.** Accuracy, per-direction
   recall@10/MRR, expansion accuracy, and the gate verdict are recomputed
   from each run's records; a run's own totals are never trusted. Regenerate
   any report keyless and offline: `bun run eval:decision-bench -- --report-only`,
   `bun run eval:embed-bench -- --report-only`,
   `bun run eval:router-bench -- --report-only`, or
   `bun run eval:summarizer-bench -- --report-only`.
5. **A re-seal archives.** Any byte of a sealed sample changed bumps the seal
   version and moves the runs it invalidated to `superseded/v<n>/` in the
   same PR — the old measurement stays frozen with the generation it
   measured.
6. **The gate decides nothing by itself.** Decision floors (ADR-0042): overall
   ≥ 0.85 AND every language ≥ 0.75 (≥ 3 scored cases per language). Embedding
   floors (ADR-0013): cross-lingual `secondary→primary` recall@10 ≥ 0.70 AND
   monolingual `primary→primary` recall@10 ≥ 0.75. The router and
   summarizer benches reuse the ADR-0042 floors, and the summarizer gate scores
   only what is deterministic (format bounds, faithfulness grounding) — every
   summary is printed in its report, and theme quality stays the owner's call.
   Adoption is a
   `benchAdoption` / `embedder` role config change made by a reviewed PR; the
   report supplies evidence, never a switch.

## Running

```sh
bun run eval:decision-bench                     # all keyed decision candidates
bun run eval:decision-bench -- --model 'perplexity/pplx-decider-v1.2-20261016'   # one arm (additive)
bun run eval:decision-bench -- --force --model '~typesafe/jev-latest'   # deliberate re-run
bun run eval:decision-bench -- --report-only    # regenerate report.md — no key, no network

bun run eval:embed-bench                        # all keyed embedder candidates
bun run eval:embed-bench -- --model 'gemini-embedding-001'              # one arm (additive)
bun run eval:embed-bench -- --force --model 'gemini-embedding-001'      # deliberate re-run
bun run eval:embed-bench -- --report-only       # regenerate report.md — no key, no network

bun run eval:router-bench                       # all keyed router candidates
bun run eval:router-bench -- --model 'google/gemini-3.8-flash'          # one arm (additive)
bun run eval:router-bench -- --force --model 'google/gemini-3.8-flash'  # deliberate re-run
bun run eval:router-bench -- --report-only      # regenerate report.md — no key, no network

bun run eval:summarizer-bench                       # all keyed summarizer candidates
bun run eval:summarizer-bench -- --model 'z-ai/glm-5.3-flash'           # one arm (additive)
bun run eval:summarizer-bench -- --force --model 'z-ai/glm-5.3-flash'   # deliberate re-run
bun run eval:summarizer-bench -- --report-only      # regenerate report.md — no key, no network
```

The decision, router and summarizer benches report NOT RUN and exit 0 when
`OPENROUTER_API_KEY` is absent (CI posture). The embed bench fails fast on a
missing candidate
key instead — the gate measures every arm or it measures nothing.
`EVAL_BUDGET_MICRO_USD` caps the spend. Each invocation appends one run file
per candidate it actually ran and regenerates the report.

## Data provenance

The case fixtures' passages are verbatim from commit-safe sources — Bukhari
hadith 1 & 2 and Abu Dawud 1 (fawazahmed0/hadith-api, The Unlicense) and
Quran Arabic from the Tanzil Uthmani edition (verbatim distribution
permitted with attribution) — see each fixture's `$comment` and
`NOTICES/DATASETS.md`. The decision and summarization fixtures quote these
passages directly; the embedding samples pin the same sources through the
probe fixture's corpus fingerprint (a deterministic stratified subset of the
parsed corpus); the superseded pre-store result was measured against the
same fingerprint. The routing cases are synthetic questions over the same
topics — no verbatim source text.
