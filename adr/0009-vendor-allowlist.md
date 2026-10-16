# ADR-0009: The vendor allowlist is configuration — paid APIs accepted, price disciplined

## Decision

Every model provider this product may call is restricted to an owner-approved allowlist, and the live list is configuration, not this record: the provider config holds the vendors, their endpoints, model ids, key variables, prices, personal-data eligibility and per-role fallback chains, and the boundary gate is what keeps vendor data out of engine source.

Paid model APIs **are** accepted on the critical path, which replaces the template's guardrail against paid services there. The price of that acceptance: price is weighed in every model decision, cost is traced per query, free tiers are used only where quality allows, personal data never routes through a free tier, and a tie between near-equal candidates goes to the cheaper one. No code path branches on vendor or model identity, and every call records the model it actually ran on.

A chain may not advertise a fallback that cannot be wired: a tail depending on an unbound key is removed rather than kept as decoration, so a single-candidate role is an accepted single point of failure, and restoring a candidate means binding its key as well as re-adding it. Same-vendor review is accepted deliberately, and only with the reopen condition that binding a second paid vendor key restores cross-vendor review by configuration alone.

## Why

No free tier exists at generator quality, which is what makes the template guardrail's exception a decision rather than an oversight. The cheaper pairing is a hypothesis, not a proven posture: the Golden Set run must show it neither lets ungrounded citations through nor inflates refusals, and a regression in either direction reverts the chain head — one config line per role. A stronger reviewer stays catalogued as the documented promotion path, but its candidate must be re-added once its key is bound.

Vendor separation is what makes a review independent, and that independence is carried by the deterministic, grammar-driven citation validator that refuses before any model is consulted; model tier is a cost and capability dial.

Rejected: buying a second vendor's key to keep an expensive pairing at a multiple of the per-answer price, against a stated posture of best value rather than quality at any price; one vendor generating and reviewing, which is self-review and would leave the reviewer gate formally intact while hollowing it out; a challenger whose key nobody has bound and whose review quality is unmeasured; a staging-only model override, which leaves the product default unexamined while adding configuration surface.

## Consequences

- Vendor data lives in configuration only; the engine never names a vendor, and the boundary gate enforces it over source and migration SQL.
- Every call's cost lands on the trace of the answer or run that triggered it, so a price change is a config change and a cost regression is visible per query.
- The register rule is enforced by the per-vendor personal-data flag rather than by convention, so a free tier cannot silently carry personal data (ADR-0043).
- **Revisit when** a second paid vendor key is bound — cross-vendor review returns by configuration alone — or the Golden Set shows the current chain letting ungrounded citations through or inflating refusals.
