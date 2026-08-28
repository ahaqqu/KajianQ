# Success Factors & Metrics — KajianQ / DARS

> **Companion to:** `SPECS.md` (architecture/plan) and `adr/` (decisions). **Where risks live long-term:** spec §6 (product/technical risk table) keeps risk *mitigation design*; this doc keeps the **monitorable** factors, the metrics per phase, and the explicit failure signals. Do not duplicate mitigations here — this doc answers "is it working," not "what would we do."

---

## 1. The five make-or-break factors

These are the variables on which the whole project actually succeeds or fails, ordered by decisiveness. Each row names the factor, why it is load-bearing, and the single canary metric that reveals drift first.

| # | Success factor | Why it decides the project | Canary metric |
|---|---|---|---|
| 1 | **Kitab ingestion trustworthiness** | Every moat feature (pre-600 H corpus, exact citations, madzhab comparison) collapses to "can we cite a Shamela/OCR chunk as `Vol:Page:Bab` without lying." | % of sampled chunks passing sharh/matn separation audit + spot-check cross-vendor score per title |
| 2 | **Retrieval posture survives the benchmark** | ADR-0013 bets on ID→AR cross-lingual recall on classical Arabic. If #9 fails, the whole Indonesian-first premise needs a fallback track, not a tweak. | #9 ID→AR recall@k vs threshold on real corpus |
| 3 | **Trace contract never drifts** | The feedback → Golden Set → regression loop is the only mechanism by which quality *visibly* improves. Drift silently breaks trace-anchored feedback (#13) and the eval harness (#8). | % of answers with parsable `Trace` per shared contract + cost = Σ recorded calls |
| 4 | **Bounded, curated knowledge layers** | Principle Index (#16), Terminology Graph (#24), Narrators (#29), curated `concept_links` (#22) are the non-commodity differentiators; corpus-wide inferred graphs are rejected per ADR-0016. | Golden-set score on principle/analogy questions + variant-term traps |
| 5 | **Cost discipline under real usage** | Spec §5 realistic range is ~$10–45/1K queries, generator swinging 6×. An open-source public product dies quietly if cost outruns the model. | $/1K queries against the spec band + % of free-tier calls within quality floor |

## 2. What "success" means per phase (spec §7)

Each phase has its own definition of working — the project fails in stages, not all at once. This is the instrument panel per stage; "gate" means the exit criterion blocks the next phase.

### Phase 0 — Fork & foundation (exit: template stripped, packages compile)

- **Working means:** engine packages carry zero domain logic *and stay that way*.
- **Measure:** boundary lint/test green on every PR; RagStore + Provider interfaces exist as config-swappable seams; template CI (Vitest/fast-check/BDD) green on main.
- **Failure signal:** vendor names or SQL outside adapters sneak in during the first tickets — the boundary is decided here, not later.

### Phase 1 — Data & benchmarks (exit: harness v1 passes on real corpus)

- **Working means:** #9's numbers, not vibes, pick the embedding posture. The Quran/hadith ingestion is a probe of ADR-0013, not a deliverable to rush past.
- **Measure:** ID→AR recall@k and AR→AR recall@k for `gemini-embedding-001` vs `gemini-embedding-2`; expansion micro-task accuracy (glossary slice → correct AR term); citation-validator determinism at 100%.
- **Gate:** #9 records the decision in-repo and in `model_configs`. Kitab-scale ingestion (#22, #33, #35) must not start before this green — re-embedding is the expensive mistake this rule exists to prevent.

### Phase 2 — Chat MVP + transparency (exit: `/v1/chat` + Trace panel live)

- **Working means:** every answer is grounded, strictly cited, dhaif-flagged, and carries its trace. Users can see the machinery from day one (ADR-0007).
- **Measure:** 100% citation-validator pass (no fabricated citation accepted); refusal-with-reason rate on insufficient-evidence prompts; trace completeness (router intent, sub-queries, chunks, model, tokens, cost present); thumbs-down fraction on Golden Set smoke questions.
- **Failure signal:** answers that "sound right" but fail the citation validator or omit the trace — fluency is not the metric.

### Phase 3 — Router + Principles + admin (exit: public beta)

- **Working means:** Smart Router improves retrieval measurably, Principle questions explain the lens, feedback lands in the queue, harness results are browsable.
- **Measure:** Golden Set v0 recall improvement vs single-query baseline (#14); principle-question pass rate (#16); admin Trace browser coverage; feedback → accepted-Golden-Set promotion count.
- **Gate to public beta:** Golden Set v1 (~50–100 with traps) green nightly, faithfulness judged cross-vendor.

### Phase 4 — Kitab ingestion (exit: priority corpus answers with citations)

- **Working means:** the moat is real. `Vol:Page:Bab` citations are correct on sampled chunks per work; disputed attributions excluded or labeled; FA→ID translation fidelity sampled.
- **Measure:** per-title spot-check score ≥ threshold, sharh/matn separation audit, citation-format correctness on sample, kitab-sourced Golden Set questions pass, Ihya dhaif-hadith trap and Jilani disputed-attribution trap caught.
- **Failure signal:** ingestion cost balloons above the ~$30–40 one-time band *without* quality gain — dirtier output at higher spend is the failure, not the bill itself.

### Phase 5 — Hardening & v1.0 (exit: Golden Set gate green on the release candidate)

- **Working means:** quality and spend stay under control at beta-scale traffic.
- **Measure:** $/1K queries in spec band; ~10% live faithfulness sample + all thumbs-down reviewed; abuse limits verified; load test at beta scale recorded; release notes cite the eval run.
- **Gate:** full Golden Set green on the release candidate; v1 suite stays green alongside v2 in v2.0 (#31).

## 3. Metrics system — where the numbers live and who reads them

The project already has the right storage surfaces; this is the reading discipline.

| Instrument | Stores | Populated by | Read by |
|---|---|---|---|
| `eval_runs` / `eval_results` | Postgres | `eval` package (CLI, off-Workers) | Admin harness viewer (#18/#20); release gates cite these runs |
| `answer_traces` | Postgres | every `/v1/chat` answer | User Trace panel (#12), admin Trace browser (#18), per-query cost (#18) |
| `feedback` | Postgres | `/v1/feedback` (#13) | review queue (#19); accepted → `golden_questions` |
| Ingestion reports | R2 + Postgres metadata | `rag-ingest` CLI (#6, #7, #21, #22, #29, #33, #35) | phase 4 exit reviews |
| `model_configs` | config files (source of truth) + mirrored table | PRs | admin display; #9's decision lands here |

**Cadence (from spec §3.7 / #20):** cost-capped 5–10 question smoke per PR; full Golden Set gates every release + nightly; cross-vendor faithfulness judge on the full set.

**The rule a metric has to obey:** every number above is queryable from Postgres or recorded in-repo — no "check the logs," no "re-run it later." If a monitoring question can't be answered from the stored surfaces, the surface is missing a field and that belongs in the same PR as the feature.

## 4. What to watch *between* phases (slow-drift risks)

These don't announce themselves in a single failing test; they drift:

- **Trace payload drift across agent sessions.** Multiple AI sessions will build the pipeline in pieces; the shared `contracts` types are the fence. Watch for UI/admin reading shapes that the pipeline didn't write.
- **Untraced LLM calls.** Cache warming, side validations, gap-detection calls. Watch `recorded cost = Σ calls` per run; a gap means an invisible call.
- **"Helpful" gap-closing synthesis.** Post-ADR-0015, the Golden Set needs at least one novel-qiyas bait question per suite version — or the drift only shows up as scholar complaints.
- **Curation debt.** Principle Index, terminology graph review, Ghazali bibliography: these are human-gated and will slip quietly while code tickets look green. Track the *accepted-review* counts, not just the pipeline runs.
- **Template-sync divergence.** Upstream template fixes vs. fork guardrail amendment (#3): watch that ADR-0009's paid-critical-path amendment isn't silently reverted by a sync.

## 5. One-sentence summary

The project succeeds if the cleaning pipeline earns trust before scale, #9 decides the language posture by numbers, the trace contract never drifts across agents, the knowledge layers stay curated rather than inferred — and it stays inside the cost band long enough to matter.
