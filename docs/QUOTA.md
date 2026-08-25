# Free-tier quota monitoring

| Resource | Free quota | Watch |
|---|---|---|
| Workers | 100k req/day · 10ms CPU | CF Analytics |
| D1 | 5M reads · 100k writes/day | D1 metrics |
| R2 | 10GB · Class A/B ops | R2 metrics |
| Sentry | 5k errors / mo | Degrades off when exhausted |

## CI / staging hygiene

- BDD and ZAP against staging must clean test rows (`title LIKE 'e2e-%'`).
- Prefer batched sync over chatty writes.
- Fail the deploy pipeline if staging error rate spikes (manual review until automated).

## Alerting (manual for template)

Weekly: open CF dashboard → Workers / D1 / R2 → confirm &lt;50% of free caps.
