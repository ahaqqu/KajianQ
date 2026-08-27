# Free-tier quota monitoring

| Resource | Free quota | Watch |
|---|---|---|
| Workers | 100k req/day · 10ms CPU | CF Analytics |
| Durable Objects | 1M requests/mo · 400k GB-s/mo · 5GB storage | DO metrics |
| D1 | 5M reads · 100k writes/day | D1 metrics |
| R2 | 10GB · Class A/B ops | R2 metrics |
| Sentry | 5k errors / mo | Degrades off when exhausted |

Rate limiting adds one Durable Object request per `/v1/*` request (the Durable
Object per key stores a single fixed-window counter and self-clears via an
alarm, so storage stays negligible). Watch DO requests alongside Workers
requests — it is the tighter of the two per-request caps.

## CI / staging hygiene

- BDD and ZAP against staging must clean test rows (`title LIKE 'e2e-%'`).
- Prefer batched sync over chatty writes.
- Fail the deploy pipeline if staging error rate spikes (manual review until automated).

## Alerting (manual for template)

Weekly: open CF dashboard → Workers / Durable Objects / D1 / R2 → confirm &lt;50% of free caps.
