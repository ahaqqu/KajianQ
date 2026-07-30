---
name: ship
description: Use when deploying to staging, running pre-prod validation, promoting to production, or handling rollbacks. CI (GitHub Actions) runs DAST, fuzz, and smoke — this skill guides manual intervention.
disable-model-invocation: true
---

# Ship — Deploy & Validate

Take a change from CI-green on `main` through staging validation to production, with smoke tests and rollback capability at each step.

## Inputs

- `docs/ARCHITECTURE.md` §6 (security scanning), §8 (monorepo layout), §9 (availability), §10 (reliability).
- `wrangler.toml` — environments block for staging vs production.
- `.github/workflows/staging.yml` and `deploy.yml` — CI pipeline definitions.

## Phase 1 — Deploy to staging

Staging is a production-like Worker and D1 database, but isolated. It shares the same Nix flake toolchain.

```bash
wrangler deploy --env staging
```

Verify the deployment:

```bash
curl -s https://staging.<project>.workers.dev/v1/health | jq .
```

Expected: `{"status":"ok","env":"staging"}`. If the health endpoint fails, stop — do not proceed.

## Phase 2 — Run BDD tests against staging

The BDD suite exercises user-facing flows against a live environment. Run it headless in CI or locally:

```bash
bun run e2e -- --env staging
```

Or via the E2E workflow trigger. All scenarios must pass. Staging BDD catches integration gaps that unit tests miss: real D1 queries, real R2 operations, real webhook endpoints.

**Guard:** BDD tests must run in parallel where possible but serialize scenarios that mutate shared state (webhook delivery counts, D1 row counts).

## Phase 3 — DAST (OWASP ZAP Baseline)

Run OWASP ZAP against the staging Worker to catch vulnerabilities that static analysis misses: missing headers, information leakage, injection surfaces.

```bash
zap-baseline.py -t https://staging.<project>.workers.dev -r zap-report.html
```

CI command (in staging workflow):

```yaml
- name: DAST scan
  uses: zaproxy/action-baseline@v0.12.0
  with:
    target: https://staging.${{ vars.PROJECT }}.workers.dev
```

Check the report. Fail on any High or Medium severity findings. Low findings are flagged but do not block.

## Phase 4 — API fuzzing (Schemathesis)

Fuzz the OpenAPI spec against staging. Schemathesis generates requests from the hono-openapi / Valibot route definitions and checks for 500s, timeouts, and schema violations.

```bash
schemathesis run --base-url https://staging.<project>.workers.dev \
  --checks all \
  https://staging.<project>.workers.dev/openapi.json
```

CI command:

```yaml
- name: API fuzz
  run: |
    schemathesis run \
      --base-url https://staging.${{ vars.PROJECT }}.workers.dev \
      --checks all \
      https://staging.${{ vars.PROJECT }}.workers.dev/openapi.json \
      --report
```

Fail on server errors (5xx) or response validation failures. Timeouts above 10s are flagged.

## Phase 5 — Promote to production

Once staging passes BDD, DAST, and fuzz, promote:

```bash
wrangler deploy --env production
```

Production is a separate Worker and D1. D1 is bound via `wrangler.toml`; only runtime secrets (e.g., Sentry DSN, payment provider tokens) are injected via `wrangler secret` — per environment:

```bash
wrangler secret put SENTRY_DSN --env production
```

## Phase 6 — Smoke tests

After production deploy, run a minimal health check and one critical user flow to confirm the deploy didn't break anything.

```bash
# Health
curl -sf https://<project>.workers.dev/v1/health

# Critical flow: anonymous session + sync token
curl -sf -X POST https://<project>.workers.dev/v1/auth/anonymous | jq .token
curl -sf -X GET https://<project>.workers.dev/v1/notes \
  -H "Authorization: Bearer $TEST_TOKEN" | jq .notes
```

Smoke tests are in `.github/workflows/deploy.yml` and run automatically after promotion. If smoke fails, initiate Phase 7.

## Phase 7 — Rollback

If any gate fails after promotion, roll back immediately. Cloudflare Workers support instant rollback to the previous deploy:

```bash
wrangler rollback --env production
```

Verify with the health endpoint. If D1 schema changed in the failed deploy, the previous Worker is already compatible (schema migrations are additive and backward-compatible per AGENTS.md guardrails).

## Phase 8 — Environment cleanup

Staging is a scratch environment. After promoting to production:

1. Clean up staging test data so quotas stay within free tier.
2. Reset staging D1 to match production schema.
3. Clear staging R2 test objects.

```bash
wrangler d1 execute <staging-db> --env staging --command "DELETE FROM widgets WHERE name LIKE 'test-%'"
```

## Guards

- You MUST run all four validation gates (health, BDD, DAST, fuzz) before promoting to production.
- You MUST verify secrets are set per-environment. `wrangler secret list --env production` must show all required keys.
- You MUST NEVER skip DAST or fuzz on security-sensitive changes (auth, payments, user data).
- You MUST never deploy to production from a branch that isn't `main`.
- You MUST run smoke tests within 60 seconds of promotion.
- Rollback MUST be available and tested before the first production deploy.

## Completion criterion

Deploy is done when:
- [ ] Staging health check returns 200.
- [ ] All BDD scenarios pass against staging.
- [ ] OWASP ZAP reports zero High/Medium findings.
- [ ] Schemathesis fuzz reports zero server errors.
- [ ] Production health check returns 200.
- [ ] Smoke tests pass: health endpoint + one critical user flow.
- [ ] Staging test data cleaned up.
