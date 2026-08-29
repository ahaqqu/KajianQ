---
name: kajianq-traceability
description: Enforce traceable-by-design when building or reviewing KajianQ/DARS code. Use whenever you add or change anything that calls an LLM, retrieves chunks, assembles context, generates an answer, runs an ingestion/eval batch, or renders an answer — the trace must always show how the output was built.
source: project
synced: 2026-08-29
---

# KajianQ Traceability

The product promise (spec §1.5, ADR-0007): **never hide the machinery.** Traceability is a user-facing feature, an admin debugging tool, a feedback instrument, and the regression gate — all at once. This skill is the working checklist.

## What must always be true

1. **Every answer persists a full trace** (`answer_traces` per ADR-0007): router intent JSON, sub-queries, retrieved chunks with `rrf_score`/`rank_dense`/`rank_sparse`, routing filters, model identity, tokens in/out, latency, computed cost. The trace follows a shared typed contract — `Trace` / `TraceEvent` / `CostRecord` from `packages/contracts` — consumed identically by the pipeline, the PWA, admin, and the eval harness.
2. **Every LLM call is recorded** — model identity, tokens, latency, cost attach to the trace of the answer (or ingestion/eval run) that triggered it. An untraced LLM call is a defect on the same level as a crashing one.
3. **UI renders persisted trace records** — never reconstructs pipeline internals ad hoc. The answer payload and the trace payload come from the same recorded run.
4. **Batch jobs produce reports:** ingestion runs (chunk counts, sharh/matn separation audit, spot-check scores, quarantine counts, cost), eval runs (`eval_runs`/`eval_results` with metrics), glossary builds (extraction/cluster/review counts). Reports are stored, inspectable, and citable (release notes cite the eval run).
5. **Provenance is unbroken:** `text_raw` always preserved; cleaned/translated text is new fields, never in-place edits; each `lemma` ties to evidence ayah pairs (`lemma_evidence`); v2 chains tie to `doc_children`; Golden Set cases link to the feedback report that created them.

## Trace-shaped thinking for each pipeline area

- **Smart Router stages 1–3:** every stage's JSON output (intent, sub-queries, routing decisions, applied filters) lands in the trace. Query Expansion candidates (ADR-0014) — both offered and selected terms — are recorded.
- **Retrieval:** chunk ids with both dense and sparse ranks plus fused score. When the posture is ID-fallback fusion (per the #9 gate), per-track scores stay distinguishable.
- **Assembly & generation:** final presentation order, assembled context size, cache hits, model identity, tokens, cost. Deep Think additionally records per-round coverage: passages examined vs. relevant vs. used (ADR-0011).
- **Post-processing:** citation-validator verdict per citation, dhaif flags raised, refusal events with reason and stage (ADR-0015 — a refusal is first-class trace content, not silence). A suppressed or rewritten answer must leave a trace of why.
- **Feedback:** thumbs + trace-anchored flags store the element reference; accepted reports link to the Golden Set case they became.

## When writing or reviewing code, ask

- If this answer is wrong, can the admin reconstruct *exactly* why from persisted records alone — no server logs, no re-running?
- Does every new LLM call inside a loop get aggregated into the parent trace (or its own linked trace), or does it vanish?
- If a user flags "irrelevant chunk" or "wrong citation" at a trace anchor, does the stored payload make that element identifiable without guessing?
- Does the cost number on this run equal the sum of its recorded LLM calls? (If not, one call is untraced.)
- Are trace payloads' shapes defined in `packages/contracts`? The PWA and admin share them — shape drift breaks traceability at the UI layer.

## Anti-patterns (reject in review)

- Fire-and-forget LLM calls (cache warming, side validations) with no token/cost record.
- Trace payloads hand-assembled per consumer (UI one shape, admin another, eval a third) instead of the shared `contracts` types — the drift will surface as broken trace-anchored feedback.
- Logging to stdout instead of a persisted trace ("we can grep logs later" — no; user-facing and admin views need queryable rows).
- Storing only the final fused score, losing the per-channel ranks the Trace panel and tuning need.
- Trace assembly as an afterthought bolted onto the response — it is constructed alongside the pipeline, stage by stage.
- "Temporary" shortcuts in ingestion that skip the report — quarantine buckets and spot-check scores are the trust mechanism, not bureaucracy.

## The litmus test

KajianQ's trust model is: *a skeptical user or scholar can open any answer and see everything the system used to produce it, and the owner can turn every failure report into a regression test.* If your change makes that sentence harder to keep, the change is wrong — regardless of how much simpler the code looks.

## The generator's bound (ADR-0015)

Traceability also covers *what the generator was not allowed to do.* When building or reviewing the Generator or its post-processing, check that the answer surfaces classical reasoning **as cited** (ta'lil, madzhab disagreement, applied Principles) and never synthesizes a new ruling to fill a gap. A "helpful" completion that closes a gap by inference is a trust violation the trace must make visible — if the answer would look different with a fully-traced prompt, the trace is lying by omission, and that is a defect on the same level as a missing citation.
