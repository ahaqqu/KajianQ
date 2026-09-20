# VPS privacy-hardening runbook

Reproducible steps for the netcup VPS privacy posture fixed in
[`adr/0043-netcup-vps-hosting-gdpr-posture.md`](../adr/0043-netcup-vps-hosting-gdpr-posture.md)
(retention values, encrypted backups, restore discipline). Issue: **#180
(GDPR-D)**. The Art. 30 record's TOMs this runbook implements are in
[`docs/GDPR-ARTICLE-30-RECORD.md`](./GDPR-ARTICLE-30-RECORD.md) §7.

Scope: **hardening only.** This runbook migrates no personal data and starts no
serving process. Moving the API and the database is GDPR-E (**#181**), whose
executable half is [`docs/VPS-CUTOVER-RUNBOOK.md`](./VPS-CUTOVER-RUNBOOK.md) —
run the cutover runbook, which calls this one's steps in order. The DPA must be
concluded in the netcup CCP (**#178**) before either runs. Nothing here writes
to a store that holds personal data, because on a freshly bought VPS none exists
yet.

Everything the runbook places is config-as-code under
[`provision/vps/`](../provision/vps/):

| File                                        | Lands at                                             | Purpose                                                                                        |
| ------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `apply.sh`                                  | (runs in place)                                      | Places every config below and enables the units                                                |
| `nginx/kajianq.conf`                        | `/etc/nginx/sites-available/kajianq.conf`            | Reverse proxy + the minimal access-log format                                                  |
| `logrotate/kajianq-proxy`                   | `/etc/logrotate.d/kajianq-proxy`                     | 14-day proxy access/error-log rotation                                                         |
| `logrotate/kajianq-postgres`                | `/etc/logrotate.d/kajianq-postgres`                  | 14-day Postgres log rotation                                                                   |
| `journald/kajianq.conf`                     | `/etc/systemd/journald.conf.d/kajianq.conf`          | 14-day / 512M cap for API structured logs                                                      |
| `postgres/99-kajianq.conf`                  | `/etc/postgresql/<v>/main/conf.d/99-kajianq.conf`    | Loopback-only listener; no statement text in logs                                              |
| `systemd/kajianq-api.service`               | `/etc/systemd/system/kajianq-api.service`            | Unprivileged API unit, credentials from an env file                                            |
| `systemd/kajianq-cron.service` / `.timer`   | `/etc/systemd/system/kajianq-cron.{service,timer}`   | Nightly anonymous-session reclamation (ADR-0017) at 03:17, installed and enabled by `apply.sh` |
| `systemd/kajianq-backup.service` / `.timer` | `/etc/systemd/system/kajianq-backup.{service,timer}` | Daily encrypted backup, installed and enabled by `apply.sh`                                    |
| `backup/kajianq-backup.mjs`                 | (runs in place)                                      | Encrypted dump + manifest + 30-day rolling retention                                           |
| `backup/kajianq-restore.mjs`                | (runs in place)                                      | Restore into a scratch target, re-applying erasure                                             |
| `backup/restore-drill.mjs`                  | (CI + on demand)                                     | The executable restore test                                                                    |
| `proxy.env.example` / `backup.env.example`  | `/etc/kajianq/*.env`                                 | The only place real hostnames/credentials appear                                               |

## Why nginx, and why retention rather than IP masking

**Reverse proxy: nginx.** It is the de-facto reverse proxy, it lets the
access-log format be fixed field-by-field (which is the whole point of the log
policy), and the codebase already assumes its semantics — the API's 499
"client closed request" handling in `apps/api/src/lib/errors.ts`. Caddy would
also work; it buys nothing here, because rotation is logrotate's job
(ADR-0043 decision 4), not the proxy's.

**The bootstrap's Caddy must be retired before this runbook applies.** The
baseline setup served a static page through Caddy
(`docs/VPS-BASELINE-SETUP.md`), and Caddy and nginx cannot share :80/:443.
The proxy choice is decided — nginx — and recorded in ADR-0044 decision 4, so
the teardown is a prerequisite step, not an alternative:

```bash
sudo systemctl disable --now caddy 2>/dev/null || true
sudo rm -f /etc/caddy/Caddyfile
sudo ss -lntp | grep -E ':(80|443)\b'   # must be empty before apply.sh runs
```

The full ordered cutover — including this teardown — is
[`docs/VPS-CUTOVER-RUNBOOK.md`](./VPS-CUTOVER-RUNBOOK.md) step 0.

**Retention rather than dropping/masking the IP.** ADR-0043 decision 4 fixes
this: the Art. 30 record declares "IP addresses in server access logs
(14-day retention)" to netcup, and abuse investigation needs the address.
Masking the IP would leave the declared data category false without a
compensating benefit, so the ticket's "either IP drop/mask **or** a short
documented retention with logrotate" is satisfied by the retention branch.

## Prerequisites

```bash
sudo apt-get update
sudo apt-get install -y nginx postgresql postgresql-17-pgvector postgresql-client \
                        logrotate restic age jq
```

- `postgresql-17-pgvector` (or the current major's vector package) is required
  because the engine migration runs `CREATE EXTENSION vector`
  (`packages/infra/migrations/0001_init.sql`).
- `age` is optional: restic's own client-side encryption is what makes the
  backups encrypted at rest here. `age` is installed only if you also want to
  wrap the key file at rest.
- Confirm the versions landed as expected, since the log paths in the logrotate
  stanzas assume Debian's layout: `nginx -v`, `psql --version`, `restic version`.

## Steps

### 1. Configure the box's identity (root-only env files)

```bash
sudo install -d -o root -g root -m 0700 /etc/kajianq
sudo install -o root -g root -m 0600 provision/vps/proxy.env.example  /etc/kajianq/proxy.env
sudo install -o root -g root -m 0600 provision/vps/backup.env.example /etc/kajianq/backup.env
sudoedit /etc/kajianq/proxy.env    # real domain, TLS paths, loopback upstream
sudoedit /etc/kajianq/backup.env   # repository, password-file path, PG URL
```

`apply.sh` reads `/etc/kajianq/proxy.env` and refuses to run if a placeholder
value is empty, so a half-filled file fails the apply instead of producing a
server block with `__KAJIANQ_DOMAIN__` in it.

### 2. Apply the hardening configs

```bash
sudo provision/vps/apply.sh --env /etc/kajianq/proxy.env
```

`--dry-run` prints every action without writing. The script:

1. creates the unprivileged `kajianq` service account and `/srv/kajianq`;
2. renders and installs the nginx server block, runs `nginx -t`, reloads;
3. installs both logrotate stanzas and validates them with
   `logrotate --debug` (a syntax error fails the apply now, not as a silent
   rotation failure weeks later);
4. installs the journald cap and restarts journald;
5. installs the Postgres posture and restarts Postgres (skipped with a warning
   if no Debian `conf.d` exists yet);
6. installs and **enables** — does not start — `kajianq-api.service`;
7. installs and **enables** `kajianq-cron.{service,timer}` — the nightly
   session reclamation ADR-0017 used to run as a Worker cron (ADR-0044
   decision 7), on the same 03:17 slot;
8. renders and installs `kajianq-backup.service`/`.timer` (the script path
   comes from this checkout) and **enables** the timer with
   `--now`, so the daily encrypted backup is scheduled by config-as-code, not
   by hand-copied snippets.

Verify:

```bash
systemctl status kajianq-api          # enabled; inactive until the cutover starts it
systemctl list-timers kajianq-backup.timer  # enabled, scheduled 03:15 daily
systemctl list-timers kajianq-cron.timer    # enabled, scheduled 03:17 daily
sudo logrotate --debug /etc/logrotate.d/kajianq-proxy
sudo logrotate --debug /etc/logrotate.d/kajianq-postgres
sudo nginx -T | grep -A2 log_format    # the access format, no user-agent/referer
sudo systemctl cat systemd-journald | grep -A3 '\[Journal\]'
```

Retention check (do this **after** traffic exists, so segments are real):

```bash
sudo logrotate -f /etc/logrotate.d/kajianq-proxy    # force one rotation
sudo ls -l /var/log/nginx/                          # kajianq.access.log.1.gz …
sudo logrotate --debug /etc/logrotate.d/kajianq-proxy | grep -i 'removing'
```

### 3. Point TLS at the proxy

The server block references `KAJIANQ_TLS_CERT`/`KAJIANQ_TLS_KEY`. Issue the
certificate with your ACME client of choice (certbot is the common one) and
re-run step 2 so the rendered paths match. The runbook does not automate ACME:
the certificate's account and renewal hooks are owner credentials, and a
renewal that silently stops is a worse failure than one that is visibly manual.

### 4. Create the backup repository (once)

This mints the encryption key. Do it deliberately, and record it in your
password manager — losing it makes every backup unrecoverable.

```bash
sudo install -o root -g root -m 0600 /dev/null /etc/kajianq/restic.pass
sudo sh -c 'openssl rand -base64 48 > /etc/kajianq/restic.pass'   # then copy it to your password manager
sudo chmod 0600 /etc/kajianq/restic.pass

# The repository is the encrypted storage endpoint from backup.env.
sudo sh -c '. /etc/kajianq/backup.env && restic -r "$RESTIC_REPOSITORY" init'
```

`kajianq-backup.mjs` refuses to run if the password file is group- or
world-readable: a world-readable repository key silently undoes the encryption
it exists to provide.

### 5. Take the first backup and confirm the schedule

```bash
sudo sh -c '. /etc/kajianq/backup.env && bun provision/vps/backup/kajianq-backup.mjs --label first-run'
```

Run this **before** the timer's first scheduled fire (the timer is enabled
`--now` by `apply.sh`): the one-time `restic init` in step 4 must be observed
before any automated run. The schedule itself needs no manual install —
`kajianq-backup.service` and `kajianq-backup.timer` ship as config-as-code
(`provision/vps/systemd/`) and are installed and enabled by `apply.sh`:

```bash
systemctl list-timers kajianq-backup.timer
systemctl cat kajianq-backup.service   # ExecStart points at this checkout's script
```

The 30-day rolling window is enforced by the backup script's
`restic forget --keep-daily 30 --prune` step on every run, not by the timer.

### 6. Run the restore test (the acceptance criterion)

The restore drill is executable and runs in CI
(`.github/workflows/vps-restore-drill.yml`) against a scratch Postgres with
pgvector. On the host, run the same harness against a scratch database:

```bash
# A throwaway Postgres database on the same server, not the live one.
sudo -u postgres createdb kajianq_drill_src
sudo -u postgres createdb kajianq_drill_dst

sudo sh -c '. /etc/kajianq/backup.env && \
  bun provision/vps/backup/restore-drill.mjs \
    --admin-url "postgres://postgres@127.0.0.1:5432/postgres"'
```

What it proves, in order:

1. **negative control** — a backup taken before an erasure, restored into a
   scratch location, _does_ bring the erased rows back. Without this the drill
   could pass while testing nothing;
2. **the erasure is re-applied** — the production restore script re-runs the
   reclamation (`cleanupExpiredSessions` semantics) and the Art. 17 cascade
   (`deleteUserCascade`), and the restored target then matches the live store:
   erased rows gone, a still-active user's transcript intact.

The drill drops its own scratch databases and removes its plaintext dump when
it finishes (pass `--keep` to inspect them). On a VPS without `pgvector`
available to a scratch cluster, run the drill against a container image instead:
`docker run --rm pgvector/pgvector:pg18` and point `--admin-url` at it.

**Restoring for real** (after a disaster, never to answer a subject request):

```bash
sudo sh -c '. /etc/kajianq/backup.env && \
  bun provision/vps/backup/kajianq-restore.mjs \
    --label <label> --target-url postgres://…/kajianq_restored'
```

`--target-url` is required and the script refuses a value equal to
`PGDATABASE_URL`. That refusal is the whole point: restoring over the live store
would resurrect data the live store had already erased. After a real restore,
re-run the reclamation for the affected window and repoint `DATABASE_URL` at the
scratch database only once it has been verified.

## The retention posture, in one place

| Log                            | Rotation                     | Window | Where enforced                             |
| ------------------------------ | ---------------------------- | ------ | ------------------------------------------ |
| Reverse proxy access + error   | daily, `maxsize 100M`, gzip  | 14 d   | `provision/vps/logrotate/kajianq-proxy`    |
| Postgres                       | daily, `maxsize 100M`, gzip  | 14 d   | `provision/vps/logrotate/kajianq-postgres` |
| API structured logs (journald) | byte + time cap              | 14 d   | `provision/vps/journald/kajianq.conf`      |
| Postgres backups               | daily, restic `--keep-daily` | 30 d   | `provision/vps/backup/kajianq-backup.mjs`  |

One retention value per class, all fixed by ADR-0043 decision 4. The API log is
capped at 14 days for disk hygiene as well as consistency — it carries a
correlation id and no IP address (`packages/infra/src/logger.ts`), so it is not
a personal-data store, but one number is easier to keep true in the Art. 30
record than three.

## What this runbook deliberately does not do

- **No data migration.** Moving the API and Postgres is GDPR-E (#181).
- **No serving.** `apply.sh` enables `kajianq-api.service` but does not start
  it; starting it is the cutover (`docs/VPS-CUTOVER-RUNBOOK.md`).
- **No DPA.** Concluding it in the netcup CCP is the owner's action (#178) and a
  precondition of the box touching personal data.
- **No secrets in the repo.** The only hostnames and credentials live in
  `/etc/kajianq/*.env`, mode 0600, outside version control.

## Related

- [`adr/0043-netcup-vps-hosting-gdpr-posture.md`](../adr/0043-netcup-vps-hosting-gdpr-posture.md) — the retention values and backup clause this implements
- [`docs/GDPR-ARTICLE-30-RECORD.md`](./GDPR-ARTICLE-30-RECORD.md) §6–§7 — the retention table and TOMs this runbook converts to implemented
- [`docs/GDPR-DPIA-LITE.md`](./GDPR-DPIA-LITE.md) §3 — the mitigations this runbook is evidence for
- [`adr/0038-corpus-snapshot-durability-guardrail.md`](../adr/0038-corpus-snapshot-durability-guardrail.md) — the snapshot labels and the immutable-label discipline the backup labels mirror
