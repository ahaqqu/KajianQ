# VPS cutover record — the executed log of GDPR-E's on-host half

Every command actually run on the box (or the deploying machine) while the
migration was carried out, with the decisive output and the evidence row it maps
to. Written live, in execution order — not a plan. Where a step failed and was
retried, the failure is recorded too.

**Read this as evidence, not as a manual.** The migration it records is
executed and the source it migrated off (Cloudflare Workers + Neon) is
decommissioned, so there is nothing left here to follow — it is the proof that
the GDPR-E work happened, and it is what issue #181's acceptance criteria are
walked against (see the checklist at the end). For setting up a box of your own,
[`docs/SELF-HOSTING-GUIDE.md`](./SELF-HOSTING-GUIDE.md); for running one,
[`docs/VPS-OPERATIONS.md`](./VPS-OPERATIONS.md). The one procedure here that
outlived its vendor — moving an existing database onto a new box — is in the
guide's §12.

Sanitization: the repository is public, so no real hostname, IP address,
credential, or connection string appears here — placeholders only. Real values
live in the owner's password manager and in `/etc/kajianq/*.env`, mode 0600, on
the box.

ADR: [`adr/0044-vps-serving-path-cutover.md`](../adr/0044-vps-serving-path-cutover.md).
Issue: #181. The PR-level review loop and merge are recorded on PR #189.

## Session opened — 2026-09-20

Access: the owner granted SSH key access to the baseline box as the admin user
(`<user>@<IP>`; the machine already held the key). Sudo was made passwordless
for this session at the owner's action (`/etc/sudoers.d/<user>-nopasswd`);
removing it again is a closing step of this record.

## Step 0 survey — the box as found (before any change)

Commands run via `ssh <user>@<IP>`; all output verified against the baseline
session's record (retained at the end of this file) — the box is exactly where
the baseline left it:

| Check           | Found                                                              |
| --------------- | ------------------------------------------------------------------ |
| OS              | Debian 13 (trixie), up 1 day, load ~0                              |
| Caddy           | active, serving the bootstrap site (`<IP>.sslip.io` → static page) |
| nginx           | not installed                                                      |
| Postgres        | not installed                                                      |
| Bun             | not installed                                                      |
| kajianq user    | absent                                                             |
| `/srv/kajianq`  | absent                                                             |
| `/etc/kajianq`  | absent                                                             |
| kajianq units   | none in `/etc/systemd/system/`                                     |
| restic          | not installed; `/etc/logrotate.d/` holds only package defaults     |
| Listening ports | 22 (ssh), 80/443 (caddy), 127.0.0.1:2019 (caddy admin)             |
| ufw             | active, default deny in — exactly 22/80/443 allowed (v4+v6)        |
| Disk / memory   | 125 GB volume, 1.2 GB used; 3.8 GiB RAM, 3.1 GiB free              |

Conclusion: the runbook's step 0 applies in full — nothing above the baseline
layer exists on the box yet.

## Step 0 execution — box prep (nginx replaces Caddy, Postgres, hardening, units)

In progress — appended as executed.

### Step 0 — package layer (executed 2026-09-20 ~14:40–14:50 UTC)

| Command (on the box via `ssh <user>@<IP>`)                      | Result                                                                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `sudo systemctl disable --now caddy` + `apt-get purge caddy`    | Caddy removed; `:80/:443` freed                                                                     |
| `apt-get install nginx postgresql postgresql-contrib restic`    | nginx 1.26.3, Postgres 17.11 (cluster `17/main` online on 5432), restic 0.18.0                      |
| `apt-get install postgresql-17-pgvector`                        | pgvector package installed (`pg_available_extensions` shows `vector` 0.8.0)                         |
| `apt-get install certbot python3-certbot-nginx`                 | certbot 4.0.0                                                                                       |
| `certbot certonly --nginx -d <IP>.sslip.io …`                   | Cert issued: `CN=<IP>.sslip.io`, notAfter 2026-12-19; files under `/etc/letsencrypt/live/<domain>/` |
| `/etc/kajianq/proxy.env` written (root:root 0600, 4 values)     | `KAJIANQ_DOMAIN=<IP>.sslip.io`, TLS paths, `KAJIANQ_API_UPSTREAM=http://127.0.0.1:8787`             |
| repo transferred by git bundle → bare seed → `/srv/kajianq-src` | checkout at merged GDPR-E commit `09b33ca`                                                          |
| `sudo bash provision/vps/apply.sh --env /etc/kajianq/proxy.env` | ran clean end-to-end (see below)                                                                    |

### Step 0 — apply.sh verification evidence

| Check                                 | Result                                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Units enabled                         | `kajianq-api`, `kajianq-cron.timer`, `kajianq-backup.timer` all `enabled`                                                                                                            |
| Backup timer scheduled                | next run 2026-09-21 03:15 CEST (Persistent=true)                                                                                                                                     |
| nginx site                            | `sites-enabled/kajianq.conf` symlink present; `nginx -t` OK; **nginx owns :80/:443** (ss output)                                                                                     |
| logrotate policies                    | `kajianq-proxy`, `kajianq-postgres` installed; `logrotate --debug` passed during apply                                                                                               |
| journald cap                          | `/etc/systemd/journald.conf.d/kajianq.conf` installed; journald restarted                                                                                                            |
| Postgres posture                      | `conf.d/99-kajianq.conf` installed (loopback-only, 14-day file rotation, `log_statement='none'`); restarted                                                                          |
| Service account                       | `kajianq` (uid 999, nologin), `/srv/kajianq` owned 0755                                                                                                                              |
| `vector` extension                    | installed in the `kajianq` database (`CREATE EXTENSION` → `plpgsql vector`)                                                                                                          |
| App role + DB                         | role `kajianq` (LOGIN, scram password set via `ALTER ROLE`), database `kajianq` owned by it                                                                                          |
| TCP auth check                        | `PGPASSWORD=… psql -h 127.0.0.1 -U kajianq -d kajianq` → `kajianq\|kajianq` (scram over loopback works)                                                                              |
| `listen_addresses`                    | `localhost` (loopback-only, per `99-kajianq.conf`)                                                                                                                                   |
| pg_hba                                | loopback v4/v6 `scram-sha-256` only — no wider rules                                                                                                                                 |
| HTTPS serving                         | `https://<IP>.sslip.io/` via nginx+TLS answers (403 on the empty root — nginx is the ingress)                                                                                        |
| `/etc/kajianq/api.env` written (0600) | `DATABASE_URL` (real, from `/etc/kajianq/db-password` 0600), `APP_ENV=staging`, CORS allowlist, `KAJIANQ_WEB_ROOT=/srv/kajianq/web`; provider keys left as `PLACEHOLDER_OWNER_FILLS` |
| cron timer unit                       | `kajianq-cron.timer` loaded+enabled (inactive until the API env exists — fires via the oneshot schedule)                                                                             |

Notes:

- Debian 13 ships no `pgvector` meta-package; the correct package is
  `postgresql-17-pgvector` (recorded so the next box does not trip on it).
- The kajianq role password was generated on the box, stored only in
  `/etc/kajianq/db-password` (root:root 0600), and consumed into `api.env` /
  later `backup.env`. It never left the box in any log.
- `APP_ENV=staging` until the prod cutover flips it.

### Step 0 — remainder: keys, backups, restore drill, GitHub wiring (executed 2026-09-20 ~14:50–15:05 UTC)

| Action                                                                                               | Result                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider keys into `/etc/kajianq/api.env` (from the owner's local `.env`, over the ssh session only) | `GEMINI_PAID_API_KEY` = `GEMINI_API_KEY` (same value, per owner), `DEEPSEEK_API_KEY` set; `MOONSHOT_API_KEY` / `DASHSCOPE_API_KEY` left empty (owner has none); 0 `PLACEHOLDER_OWNER_FILLS` remain                                              |
| `/etc/kajianq/backup.env` written (0600)                                                             | `RESTIC_REPOSITORY=/srv/kajianq-backups/restic` (local filesystem — external-VPS backup target deferred to a follow-up ticket), `RESTIC_PASSWORD_FILE=/etc/kajianq/restic.pass` (0600, generated on box), `PGDATABASE_URL` from the DB password |
| One-time `restic init`                                                                               | repo initialized (`config` present; empty snapshot list before first backup)                                                                                                                                                                    |
| Bun runtime installed on the box                                                                     | `unzip` + bun 1.4.2 at `/usr/bin/bun` (the systemd units' `ExecStart` path)                                                                                                                                                                     |
| First manual encrypted backup                                                                        | label `daily-20260920t125740z`, 1 snapshot in the repo (restic `snapshots` lists it; sha256 in manifest)                                                                                                                                        |
| On-host restore drill (`restore-drill.mjs`)                                                          | **OK** — all asserts PASS: backup restores into scratch; negative control shows resurrected rows without `--skip-erasure`'s re-application; production mode re-applies reclamation + Art. 17 erasure; restored store matches live store         |

Two bugs found and fixed during this remainder (both shipped-code defects that
the on-host run surfaced; fixes live in the `gdpr-e-cutover-record` branch):

1. **Backup label regex collision.** The generated label was
   `daily-20260920T125625Z` (uppercase `T`/`Z` from `toISOString()`), but
   `LABEL_RE` (`/^[a-z0-9][a-z0-9-]{2,60}$/`) is lowercase-only — the first
   backup failed with a typed error. Fix: `.toLowerCase()` on the generated
   label (matches the test fixture `"daily-20260919t031500z"`). The CI drill
   never caught it because the drill passes `--label drill` explicitly.
2. **Restore drill vs. inherited production restic env.** The drill sets its
   own `RESTIC_PASSWORD` but restic gives `RESTIC_PASSWORD_FILE` precedence —
   when the drill is run from a shell holding the production `backup.env`
   (the runbook's own example), `restic init` encrypts with the production
   key and the drill's backup child then fails with exit 12. The drill is
   self-contained by design, so the fix on-host was to run it with the
   production `RESTIC_*`/`PG*` env stripped (`env -u …`). A code-level guard
   (drill refuses inherited `RESTIC_PASSWORD_FILE`) is worth a follow-up.

GitHub wiring (set via `gh`, per the owner's request — values live only in
GitHub's store, never the repo):

- **Vars:** `VPS_HOST`, `VPS_USER`, `VPS_PUBLIC_URL` (repo-level).
- **Secrets:** `VPS_DEPLOY_SSH_KEY` (a dedicated ed25519 deploy key — not the
  owner's admin key; public half in the box's `authorized_keys`, private half
  only in the GitHub secret store, local copy destroyed after upload),
  `STAGING_DATABASE_URL` (the VPS Postgres loopback URL — staging eval/ingest
  targets the VPS DB per the issue's pre-migration note), `DEEPSEEK_API_KEY`,
  `GEMINI_API_KEY`.
- Pre-existing secrets left in place for now: `NEON_DATABASE_URL`,
  `NEON_API_KEY`, `RATE_BYPASS_PRIVATE_KEY`, `CLOUDFLARE_*` (CF ones are
  step-7 purge candidates, decommissioning is owner-gated).

Remaining step-0 precondition: the Golden Set smoke runs after the data
transfer (steps 1–3) — the DB is currently empty, so staging smoke would have
nothing to answer from.

## Steps 1–3 — data transfer, snapshot-verified (executed 2026-09-20 13:02–13:20 UTC)

| Step                                  | Command (deploying machine unless noted)                                                                                         | Result                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Pre-cutover snapshot on Neon       | `KAJIANQ_SNAPSHOT_PLAINTEXT_ACKNOWLEDGED=true bun run db:snapshot create pre-cutover-20260920t1302`                              | created in `kajianq-raw-staging`: 127.0 MB, sha256 `dcacefd2…`, source `…neon.tech/neondb @ 5a721131` (pg 18.6); rows `aligned_pairs=7781 answer_traces=202 chat_messages=445 chat_sessions=246 doc_children=8358 doc_parents=566 eval_results=159 eval_runs=42 schema_migrations=6 sessions=8292 users=8292` |
| 1. Verify against live Neon           | `bun run db:snapshot verify pre-cutover-20260920t1302`                                                                           | **verified** — sha256 matches, corpus row counts match the live database                                                                                                                                                                                                                                      |
| 2. Download                           | `db:snapshot download … --out /tmp/kajianq-transfer/…`                                                                           | wrote 127.0 MB, sha256 verified against manifest (`dcacefd2ea305d45`)                                                                                                                                                                                                                                         |
| 2. Copy to box                        | `scp` → `/srv/kajianq/restore/` (0700, postgres-owned)                                                                           | box-side sha256 identical: `dcacefd2ea305d45`                                                                                                                                                                                                                                                                 |
| 2. Restore                            | `sudo -u postgres pg_restore --clean --if-exists --no-owner --no-privileges -d postgres://kajianq:<pw>@127.0.0.1:5432/kajianq …` | 11.9 s; **2 ignored errors, both "must be owner of extension vector"** (Neon-owned extension; the app role's DB has `vector` installed by us). **Zero errors on any corpus table** — the runbook's evidence bar holds                                                                                         |
| 2. Row-count check on the box         | `psql … SELECT count(*) …`                                                                                                       | `566 / 8358 / 7781 / 6 / 8292 / 445 / 202` — **exact match with the manifest on every table**                                                                                                                                                                                                                 |
| 2. Migrations                         | `DATABASE_URL=… bun run db:status:all` then `db:up:all`                                                                          | all applied; `up: nothing to apply` (archive was current)                                                                                                                                                                                                                                                     |
| 3. Post-cutover snapshot from the VPS | ssh tunnel `-L 15433:127.0.0.1:5432` → `db:snapshot create post-cutover-20260920t1316`                                           | created: 127.0 MB, sha256 `64023db0…`, **source `127.0.0.1/kajianq @ 09b33cae` (pg 17.11 Debian — the VPS)**; rows identical to pre-cutover (34389 total both sides); privacy line: `CARRYING PERSONAL DATA — plaintext, acknowledged exposure (ADR-0043 d5)`                                                 |
| 3. Verify                             | `db:snapshot verify post-cutover-20260920t1316`                                                                                  | **verified** — sha matches, corpus row counts match the live (VPS) database                                                                                                                                                                                                                                   |
| Compare                               | manifest totals                                                                                                                  | `pre-cutover-20260920t1302` and `post-cutover-20260920t1316` both 34389 rows; per-table counts equal; ledger drift zero (nothing ran between the two)                                                                                                                                                         |

### Labels cited (AC-2)

- **pre-cutover-20260920t1302** — source Neon, verified before any transfer.
- **post-cutover-20260920t1316** — target VPS (pg 17.11), verified through the
  loopback-only tunnel.

### Defects found and fixed during the transfer (shipped-code bugs, on-host run surfaced them)

1. **`archivePrivacy` called without the environment** (`db-snapshot.mjs:108`):
   the merged privacy gate called `archivePrivacy(counts)` and the helper
   defaults `env = {}` — so the operator's `KAJIANQ_SNAPSHOT_*` flags never
   reached it and every personal-data-carrying archive was unconditionally
   `refused`. The unit tests pass `env` explicitly, so CI could not catch the
   missing argument at the call site. Fix: `archivePrivacy(counts, process.env)`.
   With the fix, the three-valued posture works as designed (the manifest now
   records `plaintext, acknowledged exposure` honestly).
2. **A mislabeled snapshot exists and is recorded, not deleted**: my first
   post-cutover attempt ran with a stale local checkout whose CLI still read
   `NEON_DATABASE_URL`, so label `post-cutover-20260920t1306` was created from
   **Neon**, not the VPS. Labels are immutable (ADR-0038), so it stays and this
   note is its correction; the true post-cutover label is `…t1316` (manifest
   source `127.0.0.1/kajianq @ 09b33cae`).
3. Snapshot label regex: same lowercase lesson as the backup label — the
   runbook's example labels are lowercase-safe, the `date -u +%Y%m%dT%H%MZ`
   shape is not. Commands here use `t`/lowercase.

## Reviewer re-head amendment (2026-09-21)

The Golden Set smoke exposed the runbook's chat-path precondition as a real
blocker: with no `MOONSHOT_API_KEY`, the reviewer stage refuses every chat
call (`personal-data call but no candidate allows personal data`) — the
`PromptSpec.personalData` enforcement working as designed, with no legal
candidate to route to. Owner decision (same day): **remove Moonshot from the
stack entirely** (never to be used); reviewer served by DeepSeek (same-vendor
review accepted, amended in ADR-0044); TypeSafe JEV cannot serve it (its
catalogued capability is `decide`, not `generate`); free-tier Gemini is
refused by the enforcement itself. Implemented in PR `gdpr-e-reviewer-deepseek`:
models.json chains, register surfaces, env plumbing, and the runbook's
precondition text all drop Moonshot.

## Post-merge staging verification (2026-09-20 ~23:30Z)

- Owner merged PR #197 (a281ac7, security headers) and #198 (0f2a4d9, docs). Staging workflow ran on main (run 35544413355): **deploy green; ZAP baseline fully green** (`FAIL-NEW: 0, WARN-NEW: 0, PASS: 62, IGNORE: 5` — the five header warnings cleared); **Schemathesis fuzz failed** — previously masked behind ZAP's failure.
- Schemathesis finding (st case noWRVW): `POST /v1/feedback` carrying both `rating` and `anchor` — schema-compliant per the emitted OpenAPI document, answered 400. Root cause: the exactly-one-feedback-shape invariant was a `v.check` cross-field rule hono-openapi never emits. Reproduced directly against staging (`status 400`).
- Fix: PR #199 (`feedback-schema-xor`, commit f67b926, merged by author per standing merge-if-CI-green authorization). `FeedbackRequestSchema` restructured as a union of the two valid shapes, each forbidding the sibling key with `v.optional(v.never())` — the invariant is now structural and visible in the emitted doc (`not: {}` clauses). Runtime behavior unchanged (all 24 pre-existing tests pass; null-valued-key semantics verified identical).
- Local gates for #199: `check`, `lint`, `test` (995 unit + 6-test real-Postgres RagStore contract suite via ssh tunnel to the VPS, green), `boundary`, `agentic-limits`, `openapi:check`. CI: bdd, drill, gate, postgres:contract all pass.
- Post-merge Staging re-run on the merge commit: awaiting result — expected fully green end-to-end for the first time since cutover.

## Live-flow verification against the VPS (2026-09-21)

Full user-journey pass exercised against `https://62.83.35.220.sslip.io` (staging), one
throwaway anonymous session per flow, all evidence captured live; every test session erased
afterwards. Owner separately smoke-tested the UI end-to-end ("i tested it works").

- **Auth**: `POST /v1/auth/anonymous` → 200 with userId/sessionId/token/expiresAt (ADR-0017
  anonymous session). Expired/erased token then answers 401 on every guarded route.
- **Chat**: `POST /v1/chat` → 200 SSE stream with the full frame set
  (`meta`, `delta`, `citations`, `trace`, `done`). Two questions exercised both answer paths:
  - "Apa hukum mencampur emas dengan perak menurut madzhab Syafii?" → explicit **refusal**
    ("tidak menemukan dalil yang memadai") with `refusal: true` in the citations frame — the
    answer-beyond-context hard boundary (#2) firing on the live box.
  - "Apa itu riba?" → full streamed answer (3,321 delta frames).
- **Trace**: the `trace` frame carries sub-queries (id + Arabic + English expansion), chunk
  refs with dense-rank scores, `models: ["deepseek-v4-flash"]` — model identity on the
  user-visible trace per traceable-by-design.
- **Feedback — thumb**: `POST /v1/feedback` `{rating: "up"}` → 200, row `pending`.
- **Feedback — anchored flag**: grounded chunk ref from the trace's chunks → 200, row echoed
  with `anchor` and `rating: "down"`; forged chunk id not grounded by the trace → **422
  invalid_anchor** (the never-without-provenance trap working in production).
- **Erasure**: `DELETE /v1/auth/me` → 200 `{"deleted": true}`; verified on the server (psql over
  ssh) that the whole user subtree cascade-drops to zero — chat_messages 2→0, answer_traces
  1→0, feedback 1→0, chat_sessions 1→0, users 1→0 — and the token is dead (401) afterwards.
  Second session repeated the flow and verified the same cascade.
- **No residue**: post-pass server counts show zero rows from the test sessions (feedback 0,
  the test message ids absent). Pre-existing staging rows are the fuzz/scan residue of the CI
  run, untouched.

## Prod cutover and decommissioning (2026-09-21, steps 4–7)

Owner approval received ("i approve you do it") covering the prod cutover,
step-7 decommissioning, and the closing sudo removal. All steps below executed
by the agent.

### The `prod` environment gate (owner setup, done by agent at owner request)

- `prod` environment created with a **required-reviewer** protection rule
  (reviewer `ahaqqu`) and a protected-branch policy — the runbook's
  "owner sign-off" is now actually enforced by GitHub, not narrative.
- Environment-scoped vars `VPS_HOST`/`VPS_USER`/`VPS_ROOT`/`VPS_PUBLIC_URL`
  and secret `VPS_DEPLOY_SSH_KEY` configured on the `prod` environment.
- The deploy key's private half had been destroyed after upload (by design),
  so a fresh dedicated ed25519 pair was generated: public half appended to the
  box's `authorized_keys` (auth verified), private half uploaded as the prod
  env secret, local material shredded.

### Step 5 — cut prod over

- `Deploy to VPS` dispatched with `environment: prod` (run 35547441652,
  commit 2d73a54). The run **waited at the approval gate**, was approved
  (GraphQL `approveDeployments`, as the configured reviewer), then ran
  **green**: build → ship → restart → smoke (health 200, session mint has
  `"token"`, `/chat` serves the SPA as HTML).
- Single-host reality: there is no separate prod host to point DNS at — the
  one box is prod now. Posture flipped accordingly: `/etc/kajianq/api.env`
  `APP_ENV=staging` → `production`, service restarted; `/v1/health` now
  reports `"env":"production"`. (`APP_ENV` is cosmetic — health JSON and log
  labels; no behavioral gate differs between staging and production.)
- `PROD_URL` variable re-pointed at `https://62.83.35.220.sslip.io`.

### Step 6 — live flows against prod (runbook evidence)

- Anonymous mint → 200; chat "Apa itu ayat kursi?" → full SSE frame set with
  trace; second chat + **grounded chunk flag** → 200 (`pending`); **forged
  anchor** → 422 `invalid_anchor`; `DELETE /v1/auth/me` → 200, token dead.
- Both timers verified scheduled: `kajianq-backup.timer` (03:15) and
  `kajianq-cron.timer` (03:17 — found dormant, `daemon-reload` + restart
  restored the schedule; the service itself executes 0/SUCCESS).
- Test session erased after the pass; no residue.

### Pre-deletion archive verification (AC for step 7)

- `post-cutover-20260920t1316` re-verified: sha256 matches, size 127.0 MB,
  **corpus row counts match the live VPS DB** (one `ct-`-prefixed
  contract-test residue row in doc_parents/doc_children — mine, from the
  tunnel-based local test run — was removed first; corpus clean).
- Two independent copies exist: the R2 snapshot archive (`kajianq-raw-staging`,
  plaintext-transitional path) and the encrypted restic repo on the box
  (snapshot `afd19227`). The two-places precondition holds.

### Step 7 — decommissioning (irreversible, owner-approved)

1. **Cloudflare Workers**: `kajianq-api-staging` deleted via API (the prod
   worker `kajianq-api` was already absent — its URL 404s and no script
   exists; deleted at some earlier point). Post-delete: the workers.dev URL
   404s, API listing shows no kajianq workers.
2. **Neon**: project `blue-bird-51941006` ("KajianQ", endpoint matches the
   old `NEON_DATABASE_URL` exactly) **deleted** after the two-copies
   verification. API listing shows zero projects; the old host no longer
   serves.
3. **R2**: **kept**. `kajianq-raw-staging` holds the corpus raw exports
   (hadith editions) and both snapshot dumps — the provenance archive
   (ADR-0038 decision 4: delete nothing that is the only copy of a paid
   asset). `kajianq-raw` (prod bucket) is empty; left in place — deleting an
   empty bucket saves nothing and the bucket remains a named target of the
   ObjectStore seam. Bucket management is now console-only (the API token is
   gone from GitHub).
4. **GitHub secrets deleted**: `CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_ACCOUNT_ID`, `NEON_API_KEY`, `NEON_DATABASE_URL`.
   **Variables**: `STAGING_URL` deleted; `PROD_URL` re-pointed at the VPS.
   `grep -rn "CLOUDFLARE\|NEON_DATABASE" .github/` returns nothing.
   Remaining secrets: `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`,
   `RATE_BYPASS_PRIVATE_KEY`, `STAGING_DATABASE_URL` (tunnel-port URL —
   still consumed by the Staging workflow), `VPS_DEPLOY_SSH_KEY` (staging
   env).

### Closing hardening step — passwordless sudo removed

- `/etc/sudoers.d/ahaqqu-nopasswd` (`ahaqqu ALL=(ALL) NOPASSWD:ALL`) deleted;
  `sudo -n` now correctly requires a password; `ahaqqu` remains in the
  `sudo` group so password-based sudo is intact. The box's VPS access
  protocol (record header) is now fully honored.

**Correction (recorded 2026-09-21, same day).** This step was correct in itself
and incomplete in its consequences: the deploy path had been running on that
temporary blanket rule, so removing it removed CI's ability to restart the
service. The next push to `main` (1242243, Staging run 35548824035) failed at
the restart step — `sudo: a password is required` — **after** the tree had
already been shipped to `/srv/kajianq`, leaving `post deploy checks` (Golden
Set smoke, ZAP, Schemathesis) skipped for that commit. The three-command grant
`docs/VPS-OPERATIONS.md` §1.5 described had never been installed; a documented
host precondition with no executable existence is the defect, and this record
stated the removal without stating the dependency.

The fix is recorded in ADR-0044's deploy-identity amendment: a dedicated
`kajianq-deploy` account owning the deployed tree, with exactly two granted
`systemctl` commands shipped as code (`provision/vps/sudoers/kajianq-deploy`,
installed by `apply.sh` behind `visudo -cf` and pinned by
`tests/scripts/vps-hardening.test.mjs`). The deploy key moves from the owner's
admin account to that identity — see the hardening runbook's key-move step.

Timeline for the next reader: the prod deploy at 00:21 UTC succeeded while the
blanket rule was still present; the rule was removed at ~02:34 CEST; the first
push after it failed at 00:47 UTC.

### Defect found while applying the deploy-identity fix — the nightly backup had never worked

Recorded 2026-09-21, discovered by reading the box's journal while preparing the
`apply.sh` re-run (not by any test or alert).

`provision/vps/apply.sh`'s `render()` substituted only the four nginx
placeholders. It never substituted `__KAJIANQ_BACKUP_SCRIPT__`, so
`/etc/systemd/system/kajianq-backup.service` was installed with the literal token
in `ExecStart` — and systemd does not expand variables. The token never existed
as an environment variable either, so the unit could not execute under any
configuration:

```
Sep 21 03:15:15 … bun[29887]: error: Script not found "__KAJIANQ_BACKUP_SCRIPT__"
Sep 21 03:15:15 … kajianq-backup.service: Main process exited, code=exited, status=1/FAILURE
```

Evidence of the window: `Result=exit-code`, `ExecMainStatus=1`, zero successful
runs in the journal. The **only** scheduled run to date — 03:15 on 2026-09-21 —
failed. What was done by hand earlier (the manual backups in step 0 and the
restore drill) worked because those invoked the script directly, bypassing the
unit; the automated schedule never did.

Why nothing caught it:

- `systemctl is-active kajianq-backup.timer` was `active` throughout — being
  active says the _schedule is armed_, never that the _job works_. The cutover
  record's own step-6 verification ("Both timers verified scheduled") checked
  exactly this field, so it confirmed the timer and could not have seen the
  failure.
- The hardening test asserted `ExecStart=/usr/bin/bun __KAJIANQ_BACKUP_SCRIPT__`
  was **present** — pinning the placeholder, with nothing asserting it was ever
  **substituted**. The test locked the defect's shape in place.
- ADR-0043's backup guarantee was reviewed as "implemented as code" and the
  Art. 30 TOMs row reads "Applied on the host", both on the strength of the
  files being installed. Installed-but-never-executed is the gap.

Impact: **no automated encrypted backup existed**, and the 30-day retention
window was not running. The manual restic snapshot `afd19227` (step 0) and the
R2 provenance archive were the only copies — the two-snapshot precondition for
the step-7 deletions was met independently, so the decommissioning was not
unsafe, but the ongoing guarantee was absent.

Fixes (PR `fix-backup-script-placeholder`):

1. `render()` substitutes `__KAJIANQ_BACKUP_SCRIPT__`, and now **fails closed**
   on any leftover `__KAJIANQ_*__` token — a new placeholder in any shipped
   config stops the apply naming it, instead of installing a config that breaks
   later.
2. Two derived test pins: every placeholder in a shipped config must be
   substituted by `render()`, and the leftover-token guard must run before the
   install. Both verified to fail against the defects they guard.
3. The deploy checks `Result` on the backup unit, so a broken backup fails the
   deploy rather than a green timer hiding it. `apply.sh` also runs
   `systemctl reset-failed` on the unit, so the stale failure recorded against
   the old definition does not make the check a false positive on first run.
4. The runbook's step 5 no longer merely asserts in a comment that `ExecStart`
   points at the checkout — it names the `Result` field as the real signal.

#### …and the two follow-on defects that fix exposed (2026-09-25)

Recorded because each was found only by running the real thing, and because the
first fix's own gate turned out to be wrong in the same way as the bug.

**A. After the placeholder was rendered, every run still failed (exit 1).**

```
bun[68781]: kajianq-backup: git exited 128: fatal: not a git repository
```

The unit's `WorkingDirectory` is `/srv/kajianq` (the deployed tree), but the
script it now executed lived in `/srv/kajianq-src` (the checkout). `gitInfo()`
runs `git rev-parse HEAD` for the manifest's provenance field, and `git` resolves
the repository from the _working directory_ — so it failed. The script had
dumped Postgres successfully first (23.5s CPU, 388M peak) and aborted at the
last step, writing the manifest.

Why it was fatal rather than graceful is the real defect: `kajianq-backup.mjs`
defines its own `fail()` calling `process.exit(1)`, unlike `lib.mjs`'s which
throws. **An exit is not an exception**, so the `try/catch` around `gitInfo()`'s
`run()` call was dead code — the intent (“a missing repo yields `sha: unknown`”,
which `buildManifest` already defaults to) was documented and unreachable. Fixed
with a `probe()` helper that returns `undefined` instead of exiting, `cwd` pinned
to the script's own directory.

**B. The gate added in fix 3 above was itself wrong.** It asserted
`Result=success`, but `reset-failed` — added in the same PR — clears `Result`
while leaving `ExecMainStatus=1` on systemd 257 (the box; 261 clears both,
verified locally). A reset unit therefore reported `success` about a failed run,
and the gate printed `backup unit healthy` while the backup was broken — the same
masking the gate was written to prevent. `Result` is also the wrong field in
principle: it cannot distinguish “the last run passed” from “no run since the
unit changed”. The gate now asserts the pair — exit status 0 **and** a last run
newer than the unit file — and the second condition is the only one that catches
_installed but never executed_, which was the actual state.

**C. The structural cause, fixed rather than patched.** `kajianq-backup.service`
was the only production unit executing code out of the repository checkout, which
the deploy never updates — production ran whatever revision happened to sit
there, and a re-render could wire the unit to stale code. The backup job is now a
third Bun bundle (`api/backup.js`, beside `index.js`/`cleanup.js`) shipped by
`deploy.sh`, and `ExecStart` names that static path. The placeholder is gone
rather than substituted, and the checkout is no longer production code.

Evidence sequence on the box: five scheduled runs (Sep 21–25) and one manual run
failed on the placeholder; the sixth failed on git provenance; the first success
is the run after this fix. The two-copies precondition for the step-7 deletions
was met independently (manual restic snapshot `afd19227` + the R2 provenance
archive), so the decommissioning was not unsafe — but the ongoing guarantee was
absent for the unit's entire life.

### Note on Neon API access during decommissioning

`api.neon.tech` had no DNS records from this machine (A/AAAA empty via DoH);
the API was reached through `console.neon.tech/api/v2` with the same bearer
token — recorded so the step is reproducible.

## Before this record — the box's baseline session (2026-09-20, retained provenance)

This box was not bought for the migration; it was already serving a static page.
The baseline session that took it from bare metal to that state is recorded here
because `docs/VPS-BASELINE-SETUP.md` has been retired — its bootstrap runbook is
now `docs/SELF-HOSTING-GUIDE.md` §1, which does the same layer with **nginx**
instead of the baseline's Caddy (Caddy was retired in step 0 of this record:
the two cannot share :80/:443). The facts below are what "the box as found"
above means, kept so the chain of custody has a start.

| #   | Step                                             | Result                                                                                |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 1   | SSH in as root with the provider credentials     | Host key accepted, connected                                                          |
| 2   | Identified the OS                                | **Debian 13 (trixie)** — kept as-is; not reinstalled to Ubuntu                        |
| 3   | `apt update && apt full-upgrade -y`              | System current                                                                        |
| 4   | Base tools installed                             | `ufw`, `unattended-upgrades`, `curl`, `git`, `sudo`                                   |
| 5   | Admin user created, sudo enabled, key auth added | Non-root user, `usermod -aG sudo`, laptop pubkey via `ssh-copy-id` from the laptop    |
| 6   | SSH hardened                                     | `PermitRootLogin no`, `PasswordAuthentication no`; verified from a **second** session |
| 7   | Firewall enabled                                 | `ufw`: default deny in / allow out; only 22, 80, 443 open (v4+v6)                     |
| 8   | Caddy installed                                  | From Debian's own repository — **retired in step 0 below**, replaced by nginx         |
| 9   | Static hello page + Caddy site                   | `/var/www/hello/index.html`, one server block — removed with Caddy                    |
| 10  | TLS certificate obtained                         | Let's Encrypt for the sslip.io hostname; re-issued for nginx in step 0                |

Journal access note from that session: non-root users cannot read service logs
by default on Debian; either `sudo journalctl -u <unit>` or
`sudo usermod -aG systemd-journal <user>` (applies on next login).

The baseline's own five "known deltas" were all settled before or during step 0
(nginx replaced Caddy; hardening applied; the DPA concluded; Postgres 17 +
pgvector landed and the Neon data transferred snapshot-verified). That list is
preserved in git history if the reasoning is ever needed.

## Acceptance criteria (#181) — the walk-through

This checklist used to live in `docs/VPS-CUTOVER-RUNBOOK.md`, which has been
retired now that the cutover is executed: the runbook was a **one-shot
procedure** (migrate off Cloudflare + Neon), and a self-hoster has no such
source to migrate from. It is kept here because issue #181 is still open and
closing it means walking these rows against this record — the evidence column
names what to look for above, not a command to run again.

`docs/SELF-HOSTING-GUIDE.md` §12 carries the vendor-neutral part of the
procedure (snapshot → verify → ship → restore → snapshot → compare) for anyone
moving an existing database onto a box, which is the half that outlived the
Cloudflare/Neon specifics.

**Owner-gated** rows cannot be closed by code, and the Art. 30 record's
"implemented as code, not yet applied" rows flip only with this evidence.

| #     | Acceptance criterion                                                                       | Evidence in this record                                                                                                                                                     | Gated by                    |
| ----- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| AC-1  | Pre-cutover snapshot verified on the source                                                | "Labels cited (AC-2)": `pre-cutover-20260920t1302` `created` banner (label, sha256, counts) + `verified` against live Neon                                                  | Owner                       |
| AC-2  | Postgres + pgvector restored on the VPS; post-cutover snapshot verified; both labels cited | Both manifests with an exact `tableCounts` match on the corpus + schema tables; both labels quoted in this record                                                           | Owner                       |
| AC-3  | Ingest/eval CLIs run against the VPS database                                              | The Golden Set smoke green against the VPS store; `--check` passes reported "store untouched, no LLM/embedding spend"; `db:status:all` fully applied                        | Owner                       |
| AC-4  | API serves `/v1/*` with TLS; the anonymous-session cron runs on the host                   | "Live-flow verification": unit active, timer scheduled at 03:17, HTTPS health JSON, `journalctl -u kajianq-cron` showing a completed run                                    | Owner                       |
| AC-5  | Deployer separation                                                                        | `grep -rn "alchemy" apps/` returns nothing; `deploy-vps.yml` and `provision/vps/deploy/` exist                                                                              | Repo                        |
| AC-6  | Secrets: none committed; business logic never touches `env.*`                              | `bun run boundary` clean, gitleaks clean, the `bindingsFromEnv` tests green                                                                                                 | Repo                        |
| AC-7  | Single-shot cutover, staging first                                                         | Two green deploy runs in order (staging then prod, step 5); no rollback attempted                                                                                           | Owner                       |
| AC-8  | Smoke tests pass against the VPS; e2e re-pointed                                           | 33/33 BDD scenarios green locally; the deploy script's smoke lines against the public URL                                                                                   | Repo + Owner                |
| AC-9  | `PromptSpec.personalData` on every serving call site                                       | `bun run test apps/api/src/lib/personal-data-serving.test.ts` green: every serving role has a keyed personal-data-allowed candidate                                         | Repo                        |
| AC-10 | On-host hardening applied + restore drill on the real box                                  | Step 0: `apply.sh` clean; the drill exits 0 on the host; `logrotate --debug` clean on both stanzas                                                                          | Owner                       |
| AC-11 | About-page register flips at cutover                                                       | The drift guard green with netcup `current` and the transition rows narrowed                                                                                                | Repo                        |
| AC-12 | Backup timer + cron re-homed                                                               | Both timers scheduled; a snapshot produced in the repository. **See "the nightly backup had never worked" — the scheduled unit's first real success postdates this record** | Owner                       |
| AC-13 | Decommissioning Cloudflare + Neon + CF secrets                                             | Step 7's deletion confirmations; `gh secret list` without the CF/Neon entries; the grep returning nothing                                                                   | **Owner approval required** |
| AC-14 | SPECS.md + the ADR's implementation notes updated                                          | The spec's §3/§5/§7/§8 diff and the ADR-0043 amendment in the same PR                                                                                                       | Repo                        |
| AC-15 | `NOTICES/DATASETS.md` unchanged unless corpus handling changed                             | Empty diff — raw source data stays immutable and no dataset was touched                                                                                                     | Repo                        |
| AC-16 | The notice's register flip is merged at/after cutover step 3                               | Step 3's `verified` banner exists **before** PR #189 merges; the netcup row's `In use today` is true in the same window                                                     | **Owner confirmation**      |

## After the cutover

- **The Art. 30 record flips its "not yet applied" rows** once AC-10's evidence
  exists (owner), and the notice's `planned` retention rows become `current` in
  the same edit — the two must move together or one of them is false.
- **The golden-set smoke is the standing health signal.** A red smoke after the
  move is a production incident, not a flake.
- **The retention posture is now live**: 14-day access logs, 30-day rolling
  encrypted backups, 30-day session reclamation at 03:17, and the superseded
  snapshot deletion window (ADR-0043 decision 5).
