# ADR-0022: The `Provider` seam lives in the engine; adapters are config-driven and vendor-free

## Decision

1. **The seam is in the engine.** One typed `Provider` interface — generate, stream, embed — returning its output with a cost record, sits beside the stage interfaces in `packages/rag-core`; vendor adapters implement it in `packages/infra`.
2. **Adapters are protocol implementations, not vendor files, and carry zero vendor names.** Vendor identity — endpoints, model ids, key variables, prices, personal-data eligibility — is data in a checked-in config validated at load by a vendor-name-free schema. Vendor names cannot appear in engine source, and the boundary gate needs no exemption for them.
3. **The config is the single source of truth** for role → provider, model, price and fallback candidates; the `model_configs` table is a mirror of it, not the source.
4. **Fallback is a wrapper over the resolved chain.** It retries the next candidate on transport errors, rate limits and server faults, the cost record names the candidate that answered, and an exhausted chain fails with a typed provider error.
5. **The register rule binds at the wrapper.** A call declares whether it carries personal data; the wrapper skips a candidate whose vendor does not permit it and fails rather than routing the data anyway.
6. **Streaming carries deferred cost.** A stream yields deltas and resolves its cost record when it completes, and a vendor that reports no usage yields a record marked as an estimate, never one that reads as metered.

## Why

The engine runs in more than one runtime — batch ingestion and eval CLIs beside the serving API — while official vendor SDKs carry Node-centric dependency graphs; every allowlisted vendor exposes a compatible REST endpoint, so a protocol adapter covers them all. One file per vendor with vendor constants inside would need per-file exemptions from the boundary gate: an auditable hole that grows with each vendor. Config-driven adapters close it structurally, because the gate scans TypeScript and the vendor data lives in JSON.

Rejected: per-vendor adapter files with gate exemptions; a fallback wrapper that ignores personal-data eligibility; a model id without a price entry silently costing zero — it is a load-time error instead.

## Consequences

- Swapping a vendor, model or price is a config edit; engine code, adapters and the gate stay untouched, and a fork overrides the config.
- A vendor quirk config cannot express forces a protocol-level abstraction, never a vendor-named file.
- Every call's cost lands on the trace of the answer or run that triggered it (ADR-0007).
- **Revisit when** a vendor capability the compatible protocol cannot express appears, or a second consumer needs a different vendor set.
