# ADR-0020: The dual-index schema's doubled vector storage is accepted, and bring-up runs on a sampled corpus

## Decision

1. **The doubled vector storage is accepted as the known price of the dual-index optionality.** Building both embedding tracks from the start roughly doubles vector storage over a single-index start; the trade-off is recorded so that it is weighed rather than discovered.
2. **Development and staging stores carry a sampled corpus**, not the full one, during bring-up.
3. **The host is sized for the full corpus with both vector indexes materialized.** Hosting is its own decision (ADR-0043, ADR-0044), and the sizing conclusion travels with the schema, because per-row storage is a property of the schema rather than of a provider. The figure a self-hoster sizes against lives in the host's setup runbook (`docs/VPS-SETUP.md`).

## Why

The storage cost of the optionality had to be explicit before the embedding benchmark locks the retrieval posture, because re-embedding at corpus scale is expensive. The point is to catch a plan-level miss early, not to predict bytes: the estimate is order-of-magnitude, and its conclusion moves with the schema.

Rejected: skipping the fallback track to save storage — it is exactly the optionality the dual-index decision bought; loading the full corpus into a development store.

## Consequences

- Per-row cost is dominated by the approximate-nearest-neighbour index, not by the vectors, so any reclaim targets the index first.
- The fallback track is optional at query time: if the benchmark shows primary-only retrieval meets the recall bar, its index can be dropped while its data column stays — no re-embedding, and the fallback's data is kept.
- Storage cost stays an explicit line item reviewed at production bring-up: the paid-API posture does not cover storage.
