# VPS cutover record — the executed log of GDPR-E's on-host half

The executed companion to [`docs/VPS-CUTOVER-RUNBOOK.md`](./VPS-CUTOVER-RUNBOOK.md):
every command actually run on the box (or the deploying machine) while the
migration was carried out, with the decisive output and the evidence row it
maps to. Written live, in execution order — not a plan. Where a step failed and
was retried, the failure is recorded too.

Sanitization: the repository is public, so no real hostname, IP address,
credential, or connection string appears here — placeholders only, same rule as
[`docs/VPS-BASELINE-SETUP.md`](./VPS-BASELINE-SETUP.md). Real values live in the
owner's password manager and in `/etc/kajianq/*.env`, mode 0600, on the box.

ADR: [`adr/0044-vps-serving-path-cutover.md`](../adr/0044-vps-serving-path-cutover.md).
Issue: #181. The PR-level review loop and merge are recorded on PR #189.

## Session opened — 2026-09-20

Access: the owner granted SSH key access to the baseline box as the admin user
(`<user>@<IP>`; the machine already held the key). Sudo was made passwordless
for this session at the owner's action (`/etc/sudoers.d/<user>-nopasswd`);
removing it again is a closing step of this record.

## Step 0 survey — the box as found (before any change)

Commands run via `ssh <user>@<IP>`; all output verified against
[`docs/VPS-BASELINE-SETUP.md`](./VPS-BASELINE-SETUP.md)'s record — the box is
exactly where the baseline left it:

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
