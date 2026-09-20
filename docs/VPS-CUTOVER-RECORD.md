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
