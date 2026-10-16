# ADR-0041: The per-IP rate limiter meters the `/v1` API surface only

## Decision

1. **The limiter is registered on the `/v1` surface.** Static assets and the developer documentation routes are unmetered. Security headers, CORS, the correlation id and the typed error handler still apply to every response.
2. **Harness traffic that must exceed the per-IP budget itself carries a signature-verified bypass credential** — purpose-locked to metering, expiry-gated, with the public half in code and the private half only where tokens are minted. It skips metering and nothing else: it is never a session credential, and guarded routes still enforce their own auth. Verification never throws — a missing, malformed, expired or wrong-key token degrades to ordinary metering, and every decision is logged.
3. **No environment switch disables the limiter.** An unbound or raised limit outside production is the configuration that drifts into production and stops the real limiter being exercised.

## Why

Assets and API calls share one per-IP bucket, so a page reload spends the same budget as chat calls — a false-positive class for shared addresses — and it is the API's abuse surface that the limiter exists for: chat spend and session minting. Asset volume costs neither, and every asset fetch pays a limiter round trip on the hottest path. A credential-based exemption cannot fix asset metering either, because browser-initiated asset fetches cannot carry one.

Rejected: keeping asset metering with a bypass credential as the primary fix, which cannot reach the requests that cause the harm; exempting same-origin requests by client-controlled fetch headers, a heuristic where an honest path prefix is exact; an environment-shaped kill switch.

## Consequences

- The documented rate-limit contract is unchanged on `/v1`; a path outside it is simply never limited.
- The bypass credential verifies in every environment because its public half is code; the private half is the trust anchor and rotates as a pair.
- **Revisit when** a second instance is stood up — the counter then needs one shared home — or the developer documentation routes become an abuse surface.
