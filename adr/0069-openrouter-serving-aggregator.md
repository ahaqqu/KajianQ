# ADR-0069: OpenRouter becomes the serving aggregator and the direct vendor rows retire

## Decision

One paid, DPA-covered vendor row — an OpenAI-compatible aggregator — carries
every serving role: generation, the reviewer, the router, retrieval embeddings,
and the decision seam. The direct vendor rows this replaces (the free-tier and
paid-terms Google rows, the DeepSeek row, and the TypeSafe decision row) are
removed from the provider config, not demoted; re-adding one later is a config
edit and a register row, nothing else. The embedding model ids are unchanged —
the aggregator serves the same Google models the corpus was embedded with, so
the stored vectors stay valid and no re-embed happens.

The decision seam rides the aggregator's schema-constrained structured output
under the rewritten ADR-0042; the embedder's wire carries the configured output
dimensions, and serving starts only after an embed probe against the corpus
confirms the aggregator forwards them — the store rejects any other vector
length loudly, so a silent dimension change is impossible.

## Why

The outage that prompted this: three separate vendor accounts carried the
serving path, and all three failed at once — one key dead, one prepaid balance
empty, taking both the generator and the embedder with it — with the failure
visible only as an opaque 500. One aggregator key and one prepaid balance
collapse the operating surface to a single account, a single DPA, and a single
place to top up, at price parity or better on every role. The cost is the
aggregator's per-request routing across upstream endpoints: a listed price
names the adopted listing, and per-request spread is a posture the trace's
recorded costs make visible.

The free-tier tail retires with the Google rows: the aggregator has no free
tier, and the router's free-tier saving was already recorded as immaterial. No
serving chain holds a free-tier candidate anymore — the free-tier rule survives
as policy and seam enforcement, not as wired config.

## Consequences

- The register and the notice carry one aggregator row (paid terms under the
  published DPA; the owner's recorded acceptance is the precondition for
  binding the production key); its row states the upstream routing and the
  zero-retention option.
- The personal-data filter's wired trap case retires with the free-tier tail;
  the filter's correctness stays pinned by its synthetic unit tests and the
  no-free-tier walk, which judges every chain position.
- Rollback: `PROVIDER_PROFILE=ollama` (still wired) recovers the four chat
  chains only — the embedder and the decision seam ride the aggregator under
  every profile — so the only rollback that restores serving through an
  aggregator outage is a config re-add of a direct row.
- The ADR-0042 re-bench on the aggregator's candidates is the gate before the
  decision seam serves production; both of its adoptions fail open.
