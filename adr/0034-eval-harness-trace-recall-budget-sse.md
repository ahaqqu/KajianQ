# ADR-0034: The eval harness scores recall from persisted traces, budgets both spend sides, and rides the streaming wire

## Decision

1. **Recall is read from the answer trace, not recomputed, and it has two dimensions.** The harness reads the retrieval event of the trace the API persisted for the answer and joins its chunk references to their metadata. **Source-type recall** asks whether retrieval reached the expected kinds of source; **citation-address recall** asks whether it retrieved the specific address each required citation names, in the citation gate's comparison form. What is scored is exactly what the served pipeline retrieved — no re-run drift, no second retrieval spend. Scoring therefore requires the store to be reachable, and an answer whose trace was never persisted scores as no recall rather than as a guess. The full suite passes a question only when both dimensions are complete, while the deployed smoke reports the address dimension as tracked debt without gating on it while a known retrieval gap stands; an address a fused set never retrieved is a gap the source-type dimension cannot see.
2. **One budget accumulator covers both spend sides.** The hard `EVAL_BUDGET_MICRO_USD` cap is enforced by a single accumulator that adds each answer trace's recorded event costs and any harness-side LLM costs; exceeding the cap aborts the run, fail-closed, because an over-budget eval run is a defect rather than a warning. Unset or zero is an explicit unlimited opt-out.
3. **The chat route streams one frame contract from its first release, and the harness consumes the same stream the client does** — one wire contract, two consumers, and no convenience endpoint to keep in sync. The harness tolerates server-side buffering and therefore does not measure time to first token.

## Why

Re-running retrieval inside the harness would double retrieval spend and risk scoring a result users never saw. Two budgets — one per spend side — would split the total picture, which is what the run cost. A non-streaming chat route for eval would fork the wire contract, so one stream with two consumers is the shape; the alternative is a second contract that drifts.

The structural reason is that the trace the interface renders is the same evidence the scorer reads: the trace contract is also the scoring contract, so a change to it flows into scoring automatically instead of out of it.

## Consequences

- The store becomes a hard dependency of scoring, not only of serving: the harness fails fast when it cannot read traces.
- Scoring reads the same trace shape the interface renders, so the two cannot be kept true separately.
- A run can be fully source-type-recall-complete while its required addresses were never retrieved; the report distinguishes the two, and the full suite refuses to call that run green while the deployed smoke reports the shortfall instead of reddening on it.
- The Golden Set carries a status field distinguishing draft from canonical, so content curation stays a human gate rather than an artifact of the loader.
