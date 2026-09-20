# VPS cutover runbook — data transfer, cutover, and the evidence checklist

Reproducible steps for the migration issue #181 (GDPR-E) executes: move the
Postgres + pgvector database and the serving path onto the netcup VPS, verify
the corpus and schema arrived intact by snapshot comparison, and decommission
the Cloudflare + Neon path.

**Owner-executed.** Every step below runs on the box or on the deploying
machine, with the owner's credentials. This document is the deliverable's
executable half: each step names the exact command, and
[the checklist](#evidence-checklist) names what output counts as evidence.
ADR: [`adr/0044-vps-serving-path-cutover.md`](../adr/0044-vps-serving-path-cutover.md).
The layer under this one is
[`docs/VPS-HARDENING-RUNBOOK.md`](./VPS-HARDENING-RUNBOOK.md) (log retention,
encrypted backups, restore drill) and
[`docs/VPS-BASELINE-SETUP.md`](./VPS-BASELINE-SETUP.md) (OS, SSH, firewall).

**This runbook is the migration.** Once the box is serving, the document to
operate it is [`docs/VPS-OPERATIONS.md`](./VPS-OPERATIONS.md) — deploy path,
Postgres management, backups/restore, and the monitoring story — and
[`docs/VPS-CUTOVER-RECORD.md`](./VPS-CUTOVER-RECORD.md) is the executed log of
this runbook (steps 0–3 are done; the record is append-only history).

Scope: **moving data and traffic.** Nothing here changes the product's
behaviour; a step that would is a bug in this runbook.

The repository is **public**. No real hostname, IP address, or credential
appears in this file or anywhere in the diff — the real values live in the
owner's password manager and in `/etc/kajianq/*.env`, mode 0600. Every command
below reads them from the environment or an env file.

## Order, and why it is this order

Single-shot cutover (ADR-0044 decision 2): there are no live users, so
downtime is not a concern and there is no rollback runway to build. What is
strict is **data integrity** — the snapshot and restore criteria below are
unchanged from ADR-0038, and none of them is relaxed by the missing uptime
requirement. Staging is deployed and verified first (engineering order), then
prod points at the VPS in one step.

0. Preconditions (DPA concluded, hardening applied, backup repository live)
1. Pre-cutover snapshot on the **source** database, verified
2. Transfer and restore onto the VPS
3. Post-cutover snapshot on the **target**, verified; both labels cited
4. Deploy staging, verify the Golden Set smoke green
5. Cut prod over (deploy, smoke, DNS)
6. Verify the live flows end to end
7. Decommission Cloudflare + Neon — **owner-approved in review**

Steps 0–3 are data. Steps 4–6 are serving. Step 7 is irreversible.

## 0. Preconditions

| Precondition                                 | How to confirm                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| DPA concluded at netcup (GDPR-B, #178)       | The owner has it in the netcup CCP (Master Data → Order Processing); no command checks this because it is a legal state, not a machine one. |
| Hardening applied on the box (GDPR-D, #180)  | `sudo provision/vps/apply.sh --env /etc/kajianq/proxy.env` ran clean, and the runbook's restore drill is green (below).                     |
| Encrypted backup repository live             | `sudo sh -c '. /etc/kajianq/backup.env && restic -r "$RESTIC_REPOSITORY" snapshots'` lists at least one snapshot.                           |
| Restore drill green on the host              | `sudo provision/vps/backup/restore-drill.mjs --admin-url "postgres://postgres@127.0.0.1:5432/postgres"` exits 0 (runbook step 6).           |
| nginx present, Caddy retired                 | `nginx -v` prints a version and `systemctl status caddy` reports not-found/inactive.                                                        |
| Postgres + pgvector installed, loopback-only | `psql --version`; `sudo -u postgres psql -Atc "SELECT extname FROM pg_extension"` lists `vector`.                                           |
| Deploy access from the deploying machine     | `/etc/kajianq/deploy.env` filled in, mode 0600; `ssh <user>@<host> true` succeeds non-interactively.                                        |
| `api.env` filled in from the example         | `sudo install -o root -g root -m 0600 provision/vps/api.env.example /etc/kajianq/api.env`, then fill in the real values (placeholders out). |

**Caddy teardown (ADR-0044 decision 4).** The bootstrap installed Caddy to serve
a static page. nginx must own :80/:443 before `apply.sh` runs:

```bash
sudo systemctl disable --now caddy 2>/dev/null || true
sudo rm -f /etc/caddy/Caddyfile            # the bootstrap's site
# Ports are now free; provision/vps/apply.sh installs the nginx site.
sudo nginx -t && sudo systemctl reload nginx
```

Confirm the free ports: `sudo ss -lntp | grep -E ':(80|443)\b'` shows nginx,
not caddy.

**The `api.env` keys.** The example (`provision/vps/api.env.example`) carries
every key the serving process reads; two are chat-path preconditions, not
optional: `DASHSCOPE_API_KEY` (catalogued challenger, no serving role); the reviewer shares `DEEPSEEK_API_KEY` (same-vendor amendment, 2026-09-21) and
`GEMINI_PAID_API_KEY` (the embedder head). Without them a chat question fails
its reviewer/embedder stage with a typed error — `/v1/health` and anonymous
minting still work, so the smokes alone do not prove them present. The
`DEEPSEEK_API_KEY` (generator/router head) and `GEMINI_API_KEY` /
`DASHSCOPE_API_KEY` rows complete the provider set.

## 1. Pre-cutover snapshot on the source (AC-1)

`db:snapshot` operates on whatever `DATABASE_URL` names (ADR-0044 decision 5),
so the source is just a URL. The archive carries personal data (a whole-DB
`pg_dump`), so the CLI refuses to write one to a storage target whose
encryption posture was not asserted.

```bash
export DATABASE_URL="$(op read 'op://…/neon-connection-string')"   # or however the owner holds it
export R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=…

# The pre-migration archive on the R2 target is the transitional exposure
# ADR-0043 decision 5 records. Acknowledge it explicitly rather than having the
# tool assert an encryption it cannot check.
KAJIANQ_SNAPSHOT_PLAINTEXT_ACKNOWLEDGED=true \
  bun run db:snapshot create pre-cutover-20260920T0000Z

bun run db:snapshot verify pre-cutover-20260920T0000Z
```

`verify` compares the corpus and schema-identity row counts
(`doc_parents`, `doc_children`, `aligned_pairs`, `schema_migrations`) against
the live source **exactly**, and reports the ledger/personal tables that moved
on. A red verify is never "fixed" by re-snapshotting without those tables and a
label is never deleted to reduce exposure (ADR-0043 decision 5).

**Evidence:** the `created` banner with label, sha256, and row counts; the
`verified` banner with `corpus row counts match the live database`. If ledger
tables are listed as "moved on", that is expected and must be quoted as such.

## 2. Transfer and restore onto the VPS (AC-2)

The VPS Postgres is the target. Restore is `pg_restore` from the verified
archive — never from the live source over the network, so the transferred bytes
are exactly the bytes that were hashed.

```bash
# On the box (or from a machine that can reach 5432 on the box — the listener
# is loopback-only, so this runs ON the box over an ssh session).
sudo install -d -o postgres -g postgres -m 0700 /srv/kajianq/restore
# The archive is downloaded from the ObjectStore on the deploying machine, then
# copied to the box (scp/rsync), because the box has no R2 credentials by design.
pg_restore --clean --if-exists --no-owner --no-privileges \
  -d "postgres://kajianq@127.0.0.1:5432/kajianq" \
  /srv/kajianq/restore/kajianq-pre-cutover-20260920T0000Z.dump
```

Then apply any migration the repo has and the archive does not (the archive's
`schema_migrations` ledger is the source of truth for what it already has):

```bash
DATABASE_URL="postgres://kajianq@127.0.0.1:5432/kajianq" bun run db:status:all
DATABASE_URL="postgres://kajianq@127.0.0.1:5432/kajianq" bun run db:up:all
```

**Evidence:** `pg_restore` exits 0 with no `errors ignored on restore` on a
corpus table; `db:status:all` shows every migration applied.

## 3. Post-cutover snapshot on the target, verified (AC-2)

`db:snapshot` reads the R2 credentials from its own environment and the box
**has none by design** (step 2), so this step runs on the **deploying machine**,
reaching the box's Postgres through an ssh tunnel — the listener stays
loopback-only; the tunnel is the loopback peer. The `R2_*` exports from step 1
are still in that shell (open a new one and re-export if not):

```bash
# On the deploying machine: forward a local port to the box's loopback 5432.
# Keep this shell open until the verify below is done.
ssh -N -L 5433:127.0.0.1:5432 <user>@<host> &

export DATABASE_URL="postgres://kajianq:CHANGE_ME@127.0.0.1:5433/kajianq"
export R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=…

# The data is now EU/DPA-covered, so the archive goes through the **encrypted**
# path, not the plaintext acknowledgement of step 1.
KAJIANQ_SNAPSHOT_ENCRYPTED_AT_REST=true \
  bun run db:snapshot create post-cutover-20260920T0100Z

bun run db:snapshot verify post-cutover-20260920T0100Z

# Done with the database? Kill the tunnel (find it: jobs / kill %1).
```

The verify re-reads the live database through the same `DATABASE_URL`, so the
tunnel must still be up for it. The archive lands on the same encrypted-at-rest
target step 1 used, via the same R2 credentials — no second tool, and no
plaintext copy anywhere on the box (the dump lives in the CLI's temp dir and is
deleted when `create` returns).

Post-cutover the archive goes through the **encrypted** path, not the plaintext
acknowledgement: the data is now EU/DPA-covered and the archive must not be the
unexamined copy. (The box's own encrypted-at-rest backup —
`provision/vps/backup/kajianq-backup.mjs`, restic client-side encryption — runs
on its own schedule; it is the GDPR-D durability layer, not this ADR-0038
portable snapshot, and the two coexist.)

**Compare the two labels.** The corpus and schema counts from
`post-cutover-…` must equal `pre-cutover-…` exactly; the ledger/personal tables
may differ only by traffic that happened between the two steps.

```bash
bun run db:snapshot list
```

**Evidence:** both labels' manifests, and a diff of their `tableCounts` showing
an exact match on `doc_parents`/`doc_children`/`aligned_pairs`/`schema_migrations`
and any ledger drift accounted for. **Both labels are cited in the PR.**

## 4. Deploy staging and verify the Golden Set smoke (AC-4, AC-6)

```bash
provision/vps/deploy/deploy.sh --env /etc/kajianq/deploy.env
```

The script builds, ships, restarts, and smokes the **public** URL. Then the
deployed API's own evidence job runs: the Staging workflow's `post-deploy-checks`
mints an anonymous session and runs the Golden Set smoke against the deployment.
Before the move this smoke was **red on the Cloudflare free-plan CPU wall**
(503 "Worker exceeded resource limits" skipping cases); it must be **green**
against the VPS (issue #181).

Manual equivalent:

```bash
curl -sSf https://<staging-host>/v1/health
TOKEN=$(curl -sSf -X POST https://<staging-host>/v1/auth/anonymous | jq -r .token)
EVAL_API_BASE_URL=https://<staging-host> EVAL_API_TOKEN="$TOKEN" \
  DATABASE_URL="postgres://kajianq@…/kajianq_staging" \
  EVAL_BUDGET_MICRO_USD=1000000 EVAL_SMOKE_SIZE=5 \
  bun run eval:smoke
```

**Evidence:** the deploy script's smoke lines, and the `eval:smoke` summary
showing zero skips and zero failures. A skip is a failure for this gate.

## 5. Cut prod over (AC-5)

```bash
# From GitHub Actions: Deploy to VPS → environment: prod (this requires the
# prod environment's approval, which is where the owner's sign-off lives).
# Or from the deploying machine, with the prod env file:
provision/vps/deploy/deploy.sh --env /etc/kajianq/deploy.env
```

Then point DNS at the box (the domain's A/AAAA record). The certificate is
issued for the real domain (runbook step 3), so this is the last public-facing
change.

**Evidence:** the deploy smoke lines against the prod URL, and the DNS record
resolving to the box (`dig +short <domain>` returns the box's address).

## 6. Verify the live flows end to end (AC-6)

```bash
BASE=https://<prod-domain>
curl -sSf $BASE/v1/health
SID=$(curl -sSf -X POST $BASE/v1/auth/anonymous | jq -r .token)
# Chat, trace, feedback, and auth, in one pass: ask, read the trace, rate it.
curl -sSf -N -X POST $BASE/v1/chat -H "Authorization: Bearer $SID" \
  -H 'content-type: application/json' \
  -d '{"question":"Apa itu ayat kursi?","language":"id"}' | tail -20
curl -sSf "$BASE/v1/chat/…" -H "Authorization: Bearer $SID"   # the persisted trace
# The erasure right still cascades:
curl -sSf -X DELETE $BASE/v1/auth/me -H "Authorization: Bearer $SID"
```

Also confirm the two re-homed schedules and that the rate limit still meters
`/v1` only (a burst of asset requests must not 429 a chat call):

```bash
sudo systemctl list-timers kajianq-backup.timer kajianq-cron.timer
sudo systemctl status kajianq-api --no-pager
```

**Evidence:** the health JSON, a cited answer from the chat stream, the trace
read, the 200 from the erasure call, and both timers listed as scheduled. This
is the `ship` skill's pre-prod validation, run against the real ingress.

## 7. Decommission Cloudflare + Neon (AC-12) — owner-approved

**Do not start this step until the post-cutover snapshot verifies (step 3) and
the live flows pass (step 6), and the owner has approved decommissioning in the
PR review.** It is irreversible. The same gate orders the merge itself: PR #189
merges **only at/after step 3's post-cutover snapshot has verified** (AC-16) —
that is the window in which the About page's netcup row marked
"In use today" becomes true.

1. **Cloudflare Workers**: delete the `kajianq-api` and `kajianq-api-staging`
   deployments (Workers → the worker → delete). The static-asset and Durable
   Object resources go with the deployment.
2. **Neon**: after the post-cutover archive exists in **two** independent
   places, remove the data-carrying resources (delete the project, or pause it
   to zero-cost if the owner wants a longer window).
3. **R2**: keep the raw-corpus bucket (it is the provenance archive, ADR-0038
   decision 4) **if** the owner has copied its contents or accepts the free-tier
   storage; delete nothing that is the only copy of a paid asset.
4. **GitHub secrets**: delete `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
   `NEON_DATABASE_URL`; add `VPS_DEPLOY_SSH_KEY` (already added),
   `STAGING_DATABASE_URL` if the staging smoke still needs a direct URL.
   Confirm no workflow references a deleted secret:
   `grep -rn "CLOUDFLARE\|NEON_DATABASE" .github/` must return nothing.
5. **GitHub variables**: `PROD_URL`/`STAGING_URL` become `VPS_PUBLIC_URL` per
   environment; remove the old ones.

**Evidence:** the deletion confirmations, `gh secret list` / `gh variable list`
showing the new set and the absence of the old, and the grep returning nothing.

## Evidence checklist

One row per issue #181 acceptance criterion. **Owner-gated** rows cannot be
closed by code, and the Art. 30 record's "implemented as code, not yet applied"
rows flip only with this evidence — the notice's `planned` retention rows stay
`planned` until then.

| #     | Acceptance criterion                                                                       | Command                                                                                                                                                                                                                                                             | What counts as evidence                                                                                                                                     | Gated by                        |
| ----- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| AC-1  | Pre-cutover snapshot verified on the source                                                | `bun run db:snapshot create pre-cutover-… && bun run db:snapshot verify pre-cutover-…`                                                                                                                                                                              | `created` banner (label, sha256, counts) + `verified` banner with `corpus row counts match the live database`                                               | Owner                           |
| AC-2  | Postgres + pgvector restored on the VPS; post-cutover snapshot verified; both labels cited | `pg_restore …` (step 2, on the box) && `bun run db:snapshot create post-cutover-… && bun run db:snapshot verify post-cutover-…` (step 3, on the deploying machine over the ssh tunnel)                                                                              | Both manifests with an exact `tableCounts` match on the corpus + schema tables; both labels in the PR                                                       | Owner                           |
| AC-3  | Ingest/eval CLIs run against the VPS database                                              | `DATABASE_URL=postgres://kajianq:…@127.0.0.1:5432/kajianq bun run eval:smoke` with `EVAL_API_BASE_URL`/`EVAL_API_TOKEN`/`EVAL_BUDGET_MICRO_USD` set (step 4's block); `bun run ingest:quran -- --check` and `bun run ingest:hadith -- --check` against the same URL | The smoke summary green against the VPS store; both `--check` passes reporting "store untouched, no LLM/embedding spend"; `db:status:all` fully applied     | Owner                           |
| AC-4  | API serves `/v1/*` with TLS; the anonymous-session cron runs on the host                   | `systemctl status kajianq-api`; `systemctl list-timers kajianq-cron.timer`; `curl -sSf https://<host>/v1/health`                                                                                                                                                    | Unit active, timer scheduled at 03:17, HTTPS health JSON, `journalctl -u kajianq-cron` showing a completed run                                              | Owner                           |
| AC-5  | Deployer separation                                                                        | `grep -rn "alchemy" apps/` returns nothing; `git ls-files .github/workflows/deploy-vps.yml provision/vps/deploy/`                                                                                                                                                   | The paths exist; no `alchemy:*` script and no `alchemy.run.ts` under `apps/`                                                                                | Repo (this PR)                  |
| AC-6  | Secrets: none committed; business logic never touches `env.*`                              | `bun run boundary`; the gitleaks CI step; `bun run test` (the env→bindings mapping test)                                                                                                                                                                            | Boundary clean, gitleaks clean, the `bindingsFromEnv` tests green                                                                                           | Repo (this PR)                  |
| AC-7  | Single-shot cutover, staging first                                                         | The Staging workflow run, then the prod `deploy-vps` run                                                                                                                                                                                                            | Two green deploy runs in order; no rollback step attempted                                                                                                  | Owner                           |
| AC-8  | Smoke tests pass against the VPS; e2e re-pointed                                           | `bun run e2e` — **on the deploying machine** (playwright boots `boot.ts` locally; the box has no playwright/chromium) — and the deploy script's smoke lines                                                                                                         | 33/33 BDD scenarios green locally; the deployed smoke lines against the public URL                                                                          | Repo + Owner                    |
| AC-9  | `PromptSpec.personalData` on every serving call site                                       | `bun run test apps/api/src/lib/personal-data-serving.test.ts`                                                                                                                                                                                                       | The enforcement test green: every serving role has a keyed personal-data-allowed candidate                                                                  | Repo (prior checkpoint)         |
| AC-10 | On-host hardening applied + restore drill on the real box                                  | `sudo provision/vps/apply.sh --env /etc/kajianq/proxy.env`; the runbook step 6 drill                                                                                                                                                                                | `apply.sh` clean; the drill exits 0 on the host; `logrotate --debug` clean on both stanzas                                                                  | Owner                           |
| AC-11 | About-page register flips at cutover                                                       | `bun run test apps/web/src/lib/privacy-notice.test.ts`                                                                                                                                                                                                              | The drift guard green with netcup `current` and the transition rows narrowing                                                                               | Repo (this PR)                  |
| AC-12 | Backup timer + cron re-homed                                                               | `systemctl list-timers kajianq-backup.timer kajianq-cron.timer`                                                                                                                                                                                                     | Both timers scheduled; `kajianq-backup.mjs --label first-run` produced a snapshot in the repository                                                         | Owner                           |
| AC-13 | Decommissioning Cloudflare + Neon + CF secrets                                             | Step 7's commands                                                                                                                                                                                                                                                   | Deletion confirmations; `gh secret list` without the CF/Neon entries; the grep returning nothing                                                            | **Owner approval required**     |
| AC-16 | The notice's register flip is merged at/after cutover step 3                               | This checklist: step 3's `verified` banner exists **before** PR #189 merges                                                                                                                                                                                         | The owner ticks the PR's "Merged only at/after cutover step 3" checklist item; the netcup row's `In use today` is true in the same window the merge happens | **Owner confirmation required** |
| AC-14 | SPECS.md + the ADR's implementation notes updated                                          | `git diff --stat SPECS.md adr/0043-*.md`                                                                                                                                                                                                                            | The spec's §3/§5/§7/§8 diff and the ADR-0043 amendment in the same PR                                                                                       | Repo (this PR)                  |
| AC-15 | `NOTICES/DATASETS.md` unchanged unless corpus handling changed                             | `git diff --stat NOTICES/DATASETS.md`                                                                                                                                                                                                                               | Empty — raw source data stays immutable and no dataset was touched                                                                                          | Repo (this PR)                  |

## After the cutover

- **The Art. 30 record flips its "not yet applied" rows** once AC-10's evidence
  exists (owner), and the notice's `planned` retention rows become `current` in
  the same edit — the two must move together or one of them is false.
- **The golden-set smoke is the standing health signal.** A red smoke after the
  move is a production incident, not a flake.
- **The retention posture is now live**: 14-day access logs, 30-day rolling
  encrypted backups, 30-day session reclamation at 03:17, and the superseded
  snapshot deletion window (ADR-0043 decision 5).

## Related

- [`adr/0044-vps-serving-path-cutover.md`](../adr/0044-vps-serving-path-cutover.md) — the serving path, the deployer home, and the single-shot decision this runbook executes
- [`adr/0043-netcup-vps-hosting-gdpr-posture.md`](../adr/0043-netcup-vps-hosting-gdpr-posture.md) — the register, retention values, and the snapshot personal-data flag
- [`adr/0038-corpus-snapshot-durability-guardrail.md`](../adr/0038-corpus-snapshot-durability-guardrail.md) — the snapshot discipline steps 1 and 3 rely on
- [`docs/VPS-HARDENING-RUNBOOK.md`](./VPS-HARDENING-RUNBOOK.md) — the hardening layer applied in step 0
- [`docs/GDPR-ARTICLE-30-RECORD.md`](./GDPR-ARTICLE-30-RECORD.md) — the record whose open rows the evidence closes
