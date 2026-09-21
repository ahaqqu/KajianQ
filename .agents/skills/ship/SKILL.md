---
name: ship
description: Use when deploying to staging, running pre-prod validation, promoting to production, or handling rollbacks. CI (GitHub Actions) runs DAST, fuzz, and smoke — this skill guides manual intervention.
disable-model-invocation: true
source: project
synced: 2026-08-29
---

# Ship — Deploy & Validate

Take a change from CI-green on `main` through staging validation to production, with smoke tests and rollback capability at each step.

**Post-ADR-0044 the serving host is the netcup VPS** (a plain Bun process behind
nginx), not Cloudflare Workers. There is one box: staging and production are the
same host, distinguished by `APP_ENV`. The executable record of how the move
happened is [`docs/VPS-CUTOVER-RECORD.md`](../../docs/VPS-CUTOVER-RECORD.md);
the operator's as-is manual is
[`docs/VPS-OPERATIONS.md`](../../docs/VPS-OPERATIONS.md), which is the authority
for anything below that drifts.

## Inputs

- [`docs/VPS-OPERATIONS.md`](../../docs/VPS-OPERATIONS.md) §1 (deploy path), §2
  (Postgres, migrations, snapshots, backups), §3 (monitoring).
- [`docs/VPS-HARDENING-RUNBOOK.md`](../../docs/VPS-HARDENING-RUNBOOK.md) —
  provisioning, the deploy identity's key move, retention verification.
- `provision/vps/deploy/deploy.sh` — the deploy path itself (build → ship →
  restart → smoke); `.github/workflows/deploy-vps.yml` — its CI trigger.
- `.github/workflows/staging.yml` — the post-deploy validation jobs.
- `docs/ARCHITECTURE.md` §6 (security scanning), §9 (availability), §10
  (reliability), §16 (tooling).

## Phases 1–4 are automated — do not hand-run them

The `Staging` workflow runs on every code-bearing push to `main`: it deploys via
the reusable `deploy-vps.yml`, then runs the Golden Set smoke, ZAP baseline, and
Schemathesis fuzz. The deploy script performs its own post-deploy smoke (health,
an anonymous-session mint, the SPA HTML check).

```
push to main (code-bearing)
  └─ Staging workflow
       ├─ deploy            → deploy-vps.yml → provision/vps/deploy/deploy.sh
       │                       build → rsync → restart → smoke (public URL)
       └─ post deploy checks → Golden Set smoke · ZAP · Schemathesis
```

To deploy by hand (an operator action, or a re-run):

```bash
provision/vps/deploy/deploy.sh --env /etc/kajianq/deploy.env
# or a prod dispatch, which targets the protected `prod` environment:
gh workflow run "Deploy to VPS" -f environment=prod
```

`--dry-run` prints actions without writing; `--no-smoke` skips step 4. A prod
dispatch waits at the `prod` environment's required-reviewer gate — that
approval **is** the recorded sign-off (ADR-0044 decision 2).

Check the gates rather than re-running them locally:

```bash
gh run list --branch main --limit 5     # what ran on the merge commit
gh pr checks <pr>                       # the pre-merge picture
```

Expected green: `CI` (check, lint, test, boundary, agentic-limits, openapi,
size-limit, postgres:contract), `E2E` (BDD), `VPS restore drill`, and `Staging`.
**A red `Staging` deploy is the signal that the box did not take the new code** —
read its log (`gh run view <id> --log-failed`) instead of re-deploying blind. The
known-fatal class is a missing host precondition (below).

## Host preconditions your change might depend on

The deploy depends on things that live on the box, not in the repo. If one is
missing, the deploy fails **after** shipping the tree, so the previous code keeps
running:

- **The deploy identity and its two-command grant.** `kajianq-deploy` with
  `/etc/sudoers.d/kajianq-deploy` (restart `kajianq-api.service`, start
  `kajianq-cron.service`). Installed by `provision/vps/apply.sh` and pinned by
  `tests/scripts/vps-hardening.test.mjs`, which fails the build if the deploy's
  `sudo` calls and the grant stop agreeing. The read-only `is-active` check needs
  no grant.
- **`vars.VPS_USER` naming that account**, at repo level _and_ on the `prod`
  environment (which carries its own copy). Still set to the admin login, it
  fails as `Permission denied (publickey)`.
- **`/etc/kajianq/api.env`**, including `KAJIANQ_WEB_ROOT=/srv/kajianq/web` (its
  default resolves under the unit's `WorkingDirectory` and would 503 every SPA
  route while health stayed green) and the provider keys `DEEPSEEK_API_KEY`
  (generator/router **and** reviewer head) and `GEMINI_PAID_API_KEY` (embedder
  head). Without those two the reviewer or embedder stage fails with a typed
  error **while `/v1/health` and anonymous minting stay green** — so the deploy's
  own smoke does not prove they are present; the Golden Set smoke is what
  catches it.

Moving a key or a variable is
[`docs/VPS-HARDENING-RUNBOOK.md`](../../docs/VPS-HARDENING-RUNBOOK.md) §2b–2c.

## Phase 5 — Privacy validation (before promote)

Run this once the automated gates are green on the commit you intend to promote.
It is a blocking gate on personal-data-touching releases (auth, chat, traces,
feedback, logging) — the same class of change that already requires DAST and
fuzz.

1. **Erasure flow** — create an anonymous session, send one message, then call
   `DELETE /v1/auth/me` with the session token. The response is a success, the
   session token no longer authenticates, and re-authenticating starts a fresh
   user with no transcript. This verifies the Art. 17 cascade (`deleteUserCascade`)
   still removes sessions, chat, traces, and feedback together.
2. **Privacy notice** — load `/about` on the live host and confirm a privacy
   section renders in both locales (no runtime error, no unrendered
   placeholder). This gate checks **presence and render only**; the notice's
   content accuracy is the About-page privacy notice ticket's deliverable
   (#179) — verify its copy against the Art. 30 record, not as part of this gate.

If erasure leaves any orphaned subtree row, or the notice fails to render, stop —
do not promote.

## Phase 6 — Promote to production

There is no separate production host to point DNS at: **the one box is
production**, and `APP_ENV` names the current posture (`production` since the
single-shot cutover). Promotion is:

```bash
gh workflow run "Deploy to VPS" -f environment=prod   # waits at the approval gate
```

What distinguishes it from a staging deploy is the environment: `prod` carries
the required-reviewer rule and its own environment-scoped `VPS_*` vars and
`VPS_DEPLOY_SSH_KEY`. To change the reported posture itself (cosmetic — health
JSON and log labels; no behavioral gate differs), edit `APP_ENV` in
`/etc/kajianq/api.env` on the box and restart the unit.

## Phase 7 — Smoke tests

The deploy script smokes the public URL through the proxy and TLS as its step 4:
`GET /v1/health`, `POST /v1/auth/anonymous` (must contain `"token"`), and
`GET /chat` with `accept: text/html` (must be `<!doctype html>` — the check that
pins the shipped SPA, which a missing `KAJIANQ_WEB_ROOT` or a regressed
content-type would break while health stayed green).

Re-run a single check against the live host:

```bash
curl -sf https://<host>/v1/health
curl -sf -X POST https://<host>/v1/auth/anonymous | grep -o '"token"'
curl -sf -H 'accept: text/html' https://<host>/chat | grep -qi '<!doctype html'
```

If a smoke fails, go to Phase 8.

## Phase 8 — Rollback

**There is no instant rollback: ADR-0044 decision 2 made the cutover
single-shot.** `wrangler rollback` went with the Cloudflare path, and the deploy
is an `rsync --delete` of a content-hashed build — a stale file on the box is a
stale file, not a rollback. The recorded rollback is git:

```bash
git revert <bad-commit>          # on main, via a PR
# then let Staging deploy the revert, or dispatch it:
gh workflow run "Deploy to VPS" -f environment=prod
```

The single-shot decision was made against a measured condition — no live users —
and the ADR names the revisit trigger: **when a real user base arrives, a
rollback runway becomes a new ADR**, not an improvisation. Do not build
blue/green choreography into a hotfix.

If the box is broken rather than the code (a failed migration, a wedged unit),
that is [`docs/VPS-OPERATIONS.md`](../../docs/VPS-OPERATIONS.md) §2–3 territory —
unit status, Postgres, the restore path — not this skill's Phase 8.

## Phase 9 — Environment cleanup

There is no separate staging environment to reset: staging and production share
the box and the database. What the post-deploy jobs leave is their own test
residue — the Golden Set smoke writes `eval_runs`/`eval_results` rows and
`answer_traces`, and the ZAP/Schemathesis scans leave request residue. That
residue is expected and is not cleaned automatically; the cutover record's
live-flow verification shows the pattern for checking it, and `DELETE
/v1/auth/me` covers any test _session_ you create by hand.

## Guards

- You MUST confirm the four gates green (`CI`, `E2E`, `VPS restore drill`,
  `Staging`) on the commit you promote, before promoting.
- You MUST run the Phase 5 privacy validation on personal-data-touching releases
  (auth, chat, traces, feedback, logging) and confirm the erasure flow cascades
  and the `/about` privacy section renders (copy accuracy is #179's deliverable).
- You MUST NOT hand-run the deploy to work around a red `Staging` job — read the
  failure first; the usual cause is a host precondition, and re-deploying cannot
  fix a missing grant or key.
- You MUST NEVER skip DAST or fuzz on security-sensitive changes (auth, user
  data) — check that they ran rather than assuming.
- You MUST never deploy to production from a branch that isn't `main`.
- You MUST NOT regenerate the deploy key pair to fix an auth failure; the private
  halves live only in the GitHub secret store. Fix the host side (runbook
  §2b–2c).
- Production changes that alter the reported privacy posture require the
  register, retention values, and the Art. 30 record to be true in the same PR
  (ADR-0043) — `/about` tells the same story or the PR pings #179.

## Completion criterion

Deploy is done when:

- [ ] The `Staging` workflow's deploy job is green (its smoke covers health, the
      anonymous mint, and the SPA HTML check through the public URL and TLS).
- [ ] `post deploy checks` are green: Golden Set smoke, ZAP (zero High/Medium),
      Schemathesis (zero server errors).
- [ ] `E2E` and `VPS restore drill` are green on the same commit.
- [ ] Privacy validation passes on personal-data-touching releases: erasure flow
      cascades, `/about` privacy section renders in both locales (copy accuracy
      owned by #179).
- [ ] Production dispatch approved at the `prod` gate and its deploy green.
- [ ] Any test session you created by hand is erased.
