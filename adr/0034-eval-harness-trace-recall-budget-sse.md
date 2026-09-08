# ADR-0034: Eval harness reads traces for recall, budgets both spend sides, SSE wire from day one

Date: 2026-09-08
Status: Accepted
Tickets: #8 (eval harness + Golden Set v0)
Amends: none (related: ADR-0007 traceability, ADR-0021 runner, ADR-0022 providers, ADR-0027 Effect surface)

## Context

The Golden Set harness (#8) runs versioned question sets against the staging
`/v1/chat` API with real services and scores answers. Three structural
choices were non-obvious:

1. **Where retrieval recall comes from.** The harness could re-run retrieval
   itself against the corpus, or score from what the served pipeline actually
   retrieved.
2. **Where the cost cap attaches.** The run spends money in two places: the
   harness's own LLM calls (judge/reviewer roles) and the pipeline calls the
   staging API makes on the harness's behalf.
3. **The chat wire format.** The eval client could use a plain JSON
   request/response convenience endpoint while the PWA streams, or both
   consume the same stream.

## Decision

1. **Retrieval recall is read from the answer trace, not recomputed.** The
   harness scores recall by reading the `retrieval` event of the trace the
   API persisted for the answer (`RagStore.getAnswerTraceByMessage`) and
   joining the trace's chunk refs to their source-type metadata. What is
   scored is exactly what the served pipeline retrieved — no re-run drift,
   no second retrieval spend. Consequence: scoring requires the staging
   store to be reachable (`NEON_DATABASE_URL`), and the harness cannot score
   answers whose trace was never persisted (it scores them as recall 0).

2. **One budget accumulator covers both spend sides.** The hard
   `EVAL_BUDGET_MICRO_USD` env cap is enforced by a single `Budget`
   accumulator in `packages/eval`; the harness adds (a) each answer trace's
   recorded event costs when it reads the trace, and (b) any harness-side
   LLM costs. Exceeding the cap aborts the run (fail closed — an over-budget
   eval run is a defect, not a warning). `EVAL_BUDGET_MICRO_USD` unset or
   `0` is unlimited, an explicit opt-out.

3. **`/v1/chat` streams SSE from the first release; the harness collapses
   it.** The route emits the `meta` → `delta` → `done` frame contract; the
   eval package's `postChatSse` consumes the same stream and buffers deltas.
   One wire contract, two consumers (PWA, harness), no convenience endpoint
   to keep in sync. Consequence: the harness tolerates server-side buffering
   (it does not measure time-to-first-token).

## Implementation map

- `packages/eval` — `golden-set.ts` (loader, total validation, `assertV0Shape`
  parameterized by the caller's trap-tag label so the engine stays
  vocabulary-free), `scorers.ts` (deterministic recall/citation/refusal),
  `budget.ts`, `api-client.ts`, `harness.ts` (`runGoldenSet` over
  `ChatTransport`/`AnswerTraceSource`/`RunLedger` seams).
- `packages/infra/src/rag-store-neon-eval.ts` — eval-ledger SQL
  (`insertEvalResult`, `getEvalRun`, `listEvalRuns`, `getEvalResultsByRun`) on
  the existing `eval_runs`/`eval_results` tables.
- `packages/kajianq-domain/src/chat-*.ts` — the five Smart Router stages,
  RRF(k=60) fusion + hierarchy bonuses, citation validator, ID/EN grounding
  prompts, cross-vendor reviewer; wired through `runChatPipelinePromise`
  (ADR-0021 runner; apps never hand-assemble traces).
- `apps/api/src/routes/chat.ts` + `apps/api/src/lib/chat-wiring.ts` — the
  guarded SSE route and the bindings→seams composition root (store bridge via
  the domain's `runStoreEffect`, so apps keep no direct effect import per
  ADR-0027 decision 3).
- `packages/eval/scripts/eval-run.mjs` (root `eval:run`) — the CLI
  composition root; per-question outcomes persist to `eval_results`, the
  aggregate `EvalRunReport` to `eval_runs`.
- Golden Set v0 fixture: `packages/kajianq-domain/fixtures/golden-set-v0.json`
  — 20 questions (17 ID, 2 refusal, 1 dhaif trap), Quran+hadith scope only
  (kitab questions wait for kitab ingestion), `status: "v0-draft"` until the
  owner signs the content off (model:plus-human gate on #8).

## Alternatives considered

- **Re-run retrieval in the harness** for scoring: doubles retrieval spend,
  risks scoring a different result than users saw. Rejected.
- **Two budgets (harness/pipeline)**: splits the picture the owner needs
  ("what did this run cost in total"). Rejected.
- **A non-streaming `/v1/chat` for eval**: forks the wire contract. Rejected.

## Consequences

- The staging store becomes a hard dependency of scoring (not just of
  serving) — the eval CLI fails fast when `NEON_DATABASE_URL` is absent.
- Trace contract changes flow into scoring automatically (the harness reads
  the same `Trace` shape the UI renders).
- Golden Set v0 stays a draft until owner review; the loader's `status`
  field carries the distinction (`v0-draft` / `canonical`).
