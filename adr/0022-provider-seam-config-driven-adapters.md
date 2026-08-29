# ADR-0022: Provider seam in rag-core, config-driven vendor adapters in infra

## Status

Accepted (2026-08-29). Records the composition decision for issue #5. Builds on ADR-0009 (vendor allowlist) and ADR-0021 (runner owns the trace/cost seam).

## Context

Issue #5 requires one typed `Provider` interface (`generate` / `stream` / `embed`) covering the ADR-0009 allowlist (Gemini, Kimi, DeepSeek, Qwen), with per-stage model selection driven entirely by config so operators swap vendors without code changes, per-call cost recorded for the Trace, a CLI smoke script, and a cheap-tier fallback chain (Gemini 3 Flash free tier → DeepSeek V4-Flash).

Three constraints shaped the decision:

1. **Where the seam lives.** `rag-core` stages (Router, Generator), `rag-ingest` (translation), and `eval` (judges) all consume LLM calls; implementations are vendor adapters that belong in `packages/infra` (ADR-0009, boundary gate). The seam must sit above infra so the engine never depends on the adapter home.
2. **The boundary gate scans `packages/infra/src` `.ts` files for vendor names** (`qwen|gemini|deepseek|kimi…`) with no exemption path we wanted to open. A conventional adapter (one file per vendor, vendor constants inside) would require per-file exemptions — an auditable-but-growing hole in the gate.
3. **Dual runtime.** The same code runs as Bun CLI (ingestion/eval, off-Workers) and inside the Cloudflare Workers api (ADR-0008). Official vendor SDKs have Node-centric dependency graphs; the allowlisted vendors all expose OpenAI-compatible REST endpoints.

## Decision

1. **Seam in `rag-core`.** The `Provider` interface (typed `generate` / `stream` / `embed`, returning output plus a `CostRecord` from `@app/contracts`) is defined in `packages/rag-core` next to the stage interfaces; vendor adapters in `packages/infra` implement it.
2. **Generic, config-driven adapters.** Adapters in `packages/infra` are protocol implementations (an OpenAI-compatible REST adapter, plus capability-specific adapters where a vendor lacks a compatible endpoint) containing **zero vendor names**. Vendor identity — endpoints, model ids, api-key env names, prices per MTok — is data in a checked-in **JSON config file** validated at load by a vendor-name-free Valibot schema. The boundary gate scans `.ts`, not `.json`, so the gate needs **no new exemptions**: vendor names cannot appear in any engine `.ts` file, period.
3. **One typed config file is the single source of truth** for role→provider/model/pricing/fallback-candidates, shipped with the spec §3.4 defaults. The `model_configs` DB table stays a mirror; syncing it is deferred to the admin ticket that first displays it (#18).
4. **Fallback chain in an infra wrapper.** A `FallbackProvider` (the object a role resolves to) holds the ordered candidate list from config and retries the next candidate on transport errors, 429, and 5xx. The `CostRecord` carries whichever candidate actually answered, so the Trace shows the fallback. An exhausted chain throws a typed `ProviderError`. **Personal-data enforcement (review amendment):** calls label themselves via `personalData` on the prompt/embed spec; the wrapper *skips* candidates whose vendor disallows personal data (free tiers — ADR-0009's "never route personal data through free tiers" is enforced here, not just documented), falling forward to the next allowed candidate; a chain with no allowed candidate fails with a typed `bad_request` error rather than routing the data anyway.
5. **Streaming with deferred cost.** `stream()` returns an async iterator of text deltas plus a `cost(): Promise<CostRecord>` resolving when the stream completes (from usage in the final chunk when the vendor sends it). The caller records it through `run.record` — the single trace sink (ADR-0021). `cost()` never deadlocks: when `deltas` was not consumed it drains the remainder internally. Stream latency is wall clock from request start to the end of iteration, so consumer backpressure inflates it — a documented, deliberate trade-off (eager buffering rejected as complexity for a Trace-only metric).
6. **Prices live in the same config file**, PR-reviewed like any model decision (AGENTS.md: price weighed in every decision). Cost is computed at call time as usage × price; a model id without a price entry is a wiring error that throws at load, not a silent $0. **Estimates are marked (review amendment):** `CostRecord.estimated` (optional, forward-compatible) is set whenever tokens were estimated rather than metered — a vendor that reports no streamed/embedding usage gets a heuristic count plus `estimated: true`, never a metered-looking record.

## Consequences

- Swapping a vendor, model, or price is a JSON edit + PR — engine code, adapters, and the boundary gate stay untouched. Forks override the JSON per project.
- The gate's vendor rule now has *no* exempted source files; the exemption mechanism remains for genuine future needs, and the proof is structural (`.json` is unscanned) rather than a list of exceptions.
- Adapter code must stay honest: a vendor quirk that cannot be expressed as config data forces a protocol-level abstraction, not a vendor-named file. If a quirk is truly vendor-specific and unconfigurable, that is the signal to revisit this ADR.
- The smoke script (`packages/infra/scripts/`) runs each keyed vendor through the seam and prints per-call cost; vendors without an env key are reported `NOT RUN` with exit 0 so CI stays green before #2 (vendor API keys) delivers keys. The script lives outside `infra/src`, so the gate does not scan it.
- `stream()` cost is only as accurate as the vendor's streamed usage reporting; where a vendor does not report usage on stream, the adapter estimates (token heuristics) and marks the record `estimated: true` — the Trace must never silently present an estimate as metered (now enforced in the typed contract).

## Revisit triggers

- A second DARS consumer (ADR-0005) wanting a different vendor set: the JSON moves with the fork; nothing else changes.
- A vendor capability the OpenAI-compatible protocol cannot express and config cannot parameterize: add a capability-specific adapter or amend this ADR.
- The `model_configs` mirror becomes stale-prone once #18 syncs it: consider a load-time consistency check (config vs. mirror) then.