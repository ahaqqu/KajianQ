# ADR-0009: The vendor allowlist is configuration — paid APIs accepted, price disciplined

## Decision

Every LLM and embedding provider this product may call is restricted to an owner-approved allowlist, and the live list
is configuration, not this record: the provider config under `packages/infra/src/providers/` holds the vendors, their
endpoints, model ids, key variables, prices, personal-data eligibility, and per-role fallback chains, and the boundary
gate is what keeps vendor data out of engine source.

Paid LLM and embedding APIs **are** accepted in the critical path — there is no free tier at generator quality — which
replaces the template guardrail against paid services on the critical path. The price of that acceptance: price is
weighed in every model decision, cost is traced per query, free tiers are used only where quality allows, personal
data never routes through a free tier, and when two candidates are near-equal in capability the cheaper of the two
wins. No code path branches on vendor or model identity, and every call records the model it actually ran on.

A model chain may not advertise a fallback that cannot be wired: a candidate whose key is unset is silently filtered
at resolution, so a tail depending on an unbound key is removed rather than kept as decoration, and restoring it means
re-adding the candidate **and** binding its key, not reordering a list. A single-candidate role is therefore an
accepted single point of failure when a failure costs one smoke re-run rather than data.

Vendor separation is what makes a review independent, and it is a property of the configuration: same-vendor review is
accepted deliberately only with the revisit trigger that binding a second paid vendor key restores cross-vendor review
by config alone. Independence is carried by the deterministic, grammar-driven citation validator that refuses before
any model is consulted; model tier is a cost and capability dial, and the reviewer's verdict is a hard gate rather
than a sample.

## Why

The cheaper pairing is a hypothesis, not a proven posture. The Golden Set run — free-tier capped — must show it
neither lets ungrounded citations through nor inflates refusals, and the staging smoke runs against live staging on
every deploy, not at PR time; a regression in either direction reverts the chain head, one line per role. A stronger
reviewer stays catalogued as the documented promotion path.

The chosen ids were exercised against the vendors' real endpoints rather than assumed. Two properties survive as
rules: the trace records the configured id while a vendor may echo its own canonical name, and any future per-call
token cap must leave room for a reasoning model's reasoning tokens, which are billed as output.

Rejected: buying the second vendor's key to keep the expensive pairing, roughly an order of magnitude more per answer,
against a stated posture of best value rather than quality at any price — it remains a future promotion path, but the
candidate must be re-added once the key is bound. Rejected: one vendor generating and reviewing, which is self-review
and would leave the reviewer gate formally intact while hollowing it out. Rejected: the catalogued third-vendor
challenger as reviewer, which needs a key nobody has bound and whose review quality is unmeasured. Rejected: a
staging-only model override, because there is no per-stage model seam and inventing one to avoid this decision would
leave the product default unexamined while adding configuration surface.

## Consequences

Vendor data lives in configuration only; the engine never names a vendor, and the boundary gate enforces it over both
source and migration SQL.

Every call's cost lands on the trace of the answer or run that triggered it, so a price change is a config change and
a cost regression is visible per query.

The register rule is enforced by the per-vendor personal-data flag rather than by convention, so a free tier cannot
silently carry personal data.
