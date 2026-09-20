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
