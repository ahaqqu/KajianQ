# VPS operations — the running box

The operator's manual for the netcup VPS that serves KajianQ: how to deploy,
how to manage Postgres, what hardening is applied, and what the monitoring story
is today. This is the **as-is** document for the box that is running, not the
plan for getting there.

| Document                                                                                        | Answers                                                         |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **this file**                                                                                   | How do I operate the box that is running?                       |
| [`docs/VPS-BASELINE-SETUP.md`](./VPS-BASELINE-SETUP.md)                                         | What was done to take a bare box to a serving baseline?         |
| [`docs/VPS-HARDENING-RUNBOOK.md`](./VPS-HARDENING-RUNBOOK.md)                                   | What hardening is applied, step by step, and how do I restore?  |
| [`docs/VPS-CUTOVER-RUNBOOK.md`](./VPS-CUTOVER-RUNBOOK.md)                                       | How was (and is) the data move executed? Evidence checklist.    |
| [`docs/VPS-CUTOVER-RECORD.md`](./VPS-CUTOVER-RECORD.md)                                         | What actually ran on the box, in execution order (append-only). |
| [`adr/0044-vps-serving-path-cutover.md`](../adr/0044-vps-serving-path-cutover.md)               | Why the serving path is a Bun process behind nginx.             |
| [`adr/0043-netcup-vps-hosting-gdpr-posture.md`](../adr/0043-netcup-vps-hosting-gdpr-posture.md) | Register, retention values, GDPR posture.                       |

The repository is **public**. Nothing below contains a real hostname, IP
address, credential, or user name — `<host>`, `<user>`, `<IP>` are placeholders.
The real values live in the owner's password manager and in `/etc/kajianq/*.env`
(mode 0600) on the box and on the deploying machine.

## 0. What runs on the box

```
Internet
   │  (Cloudflare DNS; the CDN proxy stays OFF — ADR-0044 decision 4)
   ▼
nginx  :443 (TLS)  ──static──▶  /srv/kajianq/web   (the React PWA build)
   │
   └──/v1/*, /openapi.json, /docs──▶  127.0.0.1:8787  kajianq-api.service
                                       (Bun, apps/api/src/boot.ts bundle)

systemd timers:
  kajianq-cron.timer    03:17 nightly   anonymous-session reclamation (ADR-0017)
  kajianq-backup.timer  03:15 nightly   encrypted restic backup (ADR-0043 d4)

Postgres 17 + pgvector   127.0.0.1:5432 only, reached over the unix socket
```

One host runs the proxy, the API, and the database (ADR-0044). Cloudflare and
Neon are decommissioned; only DNS (and optionally the CDN proxy, which must stay
off until `ngx_http_realip_module` config ships) remains at the edge.

The service account is `kajianq` (system account, `nologin`). It owns
`/srv/kajianq` and is the only account the API and cron units run as.

Bun is installed at **`/usr/bin/bun`** — outside `/home`, which the units hide
with `ProtectHome=yes`. A Bun under a home directory would be invisible to the
unit and `ExecStart` would fail with "no such file or directory"; the location
is load-bearing, not cosmetic. The units' `ExecStart` and the deploy's build
step both assume this path (a test pins it).

## 1. How to deploy

### 1.1 The deploy path, end to end

The deployer is its own concern, outside `apps/` (ADR-0044 decision 3): the
build → ship → restart → smoke path is
[`provision/vps/deploy/deploy.sh`](../provision/vps/deploy/deploy.sh), and its
CI trigger is the reusable
[`.github/workflows/deploy-vps.yml`](../.github/workflows/deploy-vps.yml). `apps/*`
carries app code and build scripts only.

```bash
provision/vps/deploy/deploy.sh --env /etc/kajianq/deploy.env
```

What it does, in order:

1. **Build.** `bun run build:web` for the PWA, then two `bun build
--target=bun` bundles from `apps/api/src/boot.ts` (serving) and
   `apps/api/src/cleanup.ts` (the nightly reclamation). Bundling for Bun is what
   makes `pg` a dependency of the artifact rather than a runtime resolve against
   a `node_modules` tree the box does not have. A missing
   `apps/web/dist/index.html` fails the deploy here — an empty web directory
   would otherwise serve the API's 503 and look like an app bug.
2. **Ship.** `rsync -az --delete --chmod=D755,F644` of the two trees to
   `/srv/kajianq/api` and `/srv/kajianq/web`. `--delete` is deliberate: the SPA
   is content-hashed, and a stale file on the box is a stale file, not a
   rollback.
3. **Restart.** `sudo systemctl restart kajianq-api.service`, then
   `is-active --quiet` so a unit that died on start fails the deploy
   immediately, then `sudo systemctl start kajianq-cron.service` once, so a
   rotated env var or a missing key fails the deploy now rather than silently at
   03:17. The timer itself is not restarted — its schedule does not depend on
   the shipped code.
4. **Smoke, against the public URL** (through DNS, the proxy, and TLS — never
   the loopback port, which would skip exactly where a TLS, upstream, header,
   or content-type regression shows up):
   - `GET /v1/health` succeeds;
   - `POST /v1/auth/anonymous` returns a body containing `"token"` — the one
     route that touches the store without an LLM, so a green mint proves proxy,
     process, and database are wired;
   - `GET /chat` with `accept: text/html` returns `<!doctype html>` — the one
     check that pins the shipped web build on the box (a missing
     `KAJIANQ_WEB_ROOT` or a regressed content-type would 503 or download here
     while health stays green).

Flags: `--dry-run` prints every action without writing; `--no-smoke` skips step
4; `--env <path>` overrides the env file. The script exits non-zero on the first
failure — a half-shipped tree that reported success is worse than a failed
deploy.

A deploy **does not**: run migrations (operator action — §2.3), take a
snapshot (§2.4), touch DNS, or restart the backup timer.

### 1.2 What triggers a deploy

| Trigger                                                    | Environment              | Where it comes from                                                                                                                   |
| ---------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Push to `main` with at least one code-bearing file         | staging                  | `Staging` workflow's `deploy` job (`paths-ignore` skips a **docs-only** push, where a deploy plus its paid smoke would be pure spend) |
| Manual dispatch of `Staging`                               | staging                  | `workflow_dispatch`, with `eval_smoke_size` / `eval_budget_micro_usd` knobs                                                           |
| Manual dispatch of `Deploy to VPS`                         | staging or prod (choice) | `workflow_dispatch`, `environment` input                                                                                              |
| Manual dispatch of `Deploy to VPS` calling `workflow_call` | staging                  | This is how `Staging` invokes it — one implementation, so the two cannot drift                                                        |

**Order and approval.** Deploys go staging first, then prod, in one step each
(single-shot cutover, ADR-0044 decision 2). The workflow sets
`environment: ${{ inputs.environment }}`, so a **prod dispatch runs against the
`prod` environment** — that environment's approval rule is where the owner's
sign-off lives, and its own `VPS_HOST`/`VPS_USER`/`VPS_PUBLIC_URL` vars and
`VPS_DEPLOY_SSH_KEY` secret must be configured for it. Staging and prod
therefore carry different host values under one repository.

`concurrency: group: deploy-vps, cancel-in-progress: false` serializes deploys:
a prod and a staging run starting together would race the same tree on the box,
and a half-shipped tree is the failure worth avoiding. The `Staging` workflow
carries its own `staging` group to serialize its jobs with each other.

### 1.3 The env files

| File                       | Lives on          | Read by                                              | Must be        |
| -------------------------- | ----------------- | ---------------------------------------------------- | -------------- |
| `/etc/kajianq/deploy.env`  | deploying machine | `deploy.sh`                                          | mode 0600      |
| `/etc/kajianq/api.env`     | the box           | `kajianq-api.service` **and** `kajianq-cron.service` | root:root 0600 |
| `/etc/kajianq/proxy.env`   | the box           | `provision/vps/apply.sh` (nginx render)              | root:root 0600 |
| `/etc/kajianq/backup.env`  | the box           | `kajianq-backup.mjs`, `kajianq-restore.mjs`          | root:root 0600 |
| `/etc/kajianq/restic.pass` | the box           | restic (via `RESTIC_PASSWORD_FILE`)                  | root:root 0600 |
| `/etc/kajianq/db-password` | the box           | operator (feeds `api.env` / `backup.env`)            | root:root 0600 |

`deploy.sh` and `apply.sh` both **refuse** to source a file with any group or
other permission bit, rather than trusting a documented `chmod`: a sourced file
is executed with the operator's privileges, so a group-writable one is a local
privilege-escalation path. Examples with every key live in
[`provision/vps/deploy/deploy.env.example`](../provision/vps/deploy/deploy.env.example),
[`provision/vps/api.env.example`](../provision/vps/api.env.example),
[`provision/vps/proxy.env.example`](../provision/vps/proxy.env.example), and
[`provision/vps/backup/backup.env.example`](../provision/vps/backup/backup.env.example).

`api.env` is the serving process's **whole** configuration (plus the cron
entry's, which reads the same `DATABASE_URL`). Its keys mirror
`apps/api/src/lib/server.ts`'s `PASSTHROUGH_KEYS` exactly — a test
(`tests/scripts/vps-hardening.test.mjs`) keeps the two in sync. Two keys are
chat-path preconditions rather than optional: `DEEPSEEK_API_KEY` (the
generator/router chain head **and** the reviewer, per the 2026-09-21
same-vendor amendment) and `GEMINI_PAID_API_KEY` (the embedder head). Without
them the reviewer or embedder stage fails with a typed error while `/v1/health`
and anonymous minting stay green — so the deploy's smokes alone do not prove
they are present.

`KAJIANQ_WEB_ROOT=/srv/kajianq/web` is load-bearing. The unit's
`WorkingDirectory` is `/srv/kajianq/api`, so the code's default
(`./apps/web/dist`) resolves to a path that does not exist on the deployed tree
and every SPA route would 503 while health stayed green.

### 1.4 GitHub variables and secrets

Repo-level values the workflows read (nothing here is in the repository):

| Kind   | Name                      | Read by                                        | Purpose                                                                    |
| ------ | ------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| var    | `VPS_HOST`                | `deploy-vps.yml` → `KAJIANQ_DEPLOY_HOST`       | the server (or an ssh-config alias)                                        |
| var    | `VPS_USER`                | `deploy-vps.yml` → `KAJIANQ_DEPLOY_USER`       | the unprivileged login user                                                |
| var    | `VPS_PUBLIC_URL`          | deploy smoke, Staging smoke, ZAP, Schemathesis | the public base URL                                                        |
| var    | `VPS_ROOT`                | `deploy-vps.yml` → `KAJIANQ_DEPLOY_ROOT`       | the deployed tree (default `/srv/kajianq`)                                 |
| secret | `VPS_DEPLOY_SSH_KEY`      | deploy + staging tunnel                        | a dedicated ed25519 deploy key, public half in the box's `authorized_keys` |
| secret | `STAGING_DATABASE_URL`    | Staging Golden Set smoke                       | the VPS Postgres loopback URL, **through the tunnel port** (§2.8)          |
| secret | `RATE_BYPASS_PRIVATE_KEY` | Staging Schemathesis fuzz                      | the purpose-locked bypass token (ADR-0041)                                 |

`deploy-vps.yml` fails at a named "Require the deploy access" step when a var or
the key is missing — an actionable failure rather than a silent no-op. The
private key is written to a runner-local file the job removes when it ends.

**Legacy variables still present.** Repo-level `PROD_URL` and `STAGING_URL`
(the Worker-era URLs) are decommissioning residue: the cutover runbook's step 7
removes them. No workflow _reads_ them — the occurrences of the name
`STAGING_URL` in `staging.yml` are that workflow's own local shell variable,
fed from `vars.VPS_PUBLIC_URL`, not the repo variable — so they are safe to
delete once the owner removes them in step 7. (The `vars.VPS_*` set above is
what the workflows actually consume.)

### 1.5 The permission model (deploy user ↔ `kajianq`)

Three distinct identities, deliberately:

- **`kajianq`** — a system account with `nologin`, created by `apply.sh`. It
  owns `/srv/kajianq`, `/srv/kajianq/api`, and `/srv/kajianq/web`
  (`kajianq:kajianq`, mode 0755) and is the user both `kajianq-api.service` and
  `kajianq-cron.service` run as. It cannot log in and is not in `sudo`.
- **the deploy user** (`<user>`) — the unprivileged login user from
  [`docs/VPS-BASELINE-SETUP.md`](./VPS-BASELINE-SETUP.md). It needs:
  - **write access to the deployed tree**, because `rsync` writes as this user
    into directories owned by `kajianq`. The repository fixes the tree's
    ownership (above) but not this grant — it is a host-side step, and the
    cutover record shows it is real: the first deploy runs failed with
    `failed to set times on "/srv/kajianq/api/."` and `mkstemp … Permission
denied`, and the next run with the same script and the same command set
    succeeded, so the change was host-side, not repo-side. The shape is
    membership in the `kajianq` group plus group-write on the tree
    (`chgrp -R kajianq /srv/kajianq` with `g+w`, and setgid on the directories
    so new files inherit the group), or ownership of the tree.
  - **sudo for exactly three commands**: `systemctl restart kajianq-api.service`,
    `systemctl is-active kajianq-api.service`, and
    `systemctl start kajianq-cron.service` (the deploy's `sudo` calls). Nothing
    else in the deploy path runs privileged; the `rsync` and the build run as
    the login user.
- **root** — `apply.sh`, `kajianq-backup.service` (it reads the restic key and
  dumps the database), and the one-time repository init.

`rsync --chmod=D755,F644` normalizes what lands: directories 0755, files 0644.
The API bundle is not written by the service account, so a deploy cannot leave a
stale file the process still holds — the restart in step 3 is what swaps the
code.

## 2. How to manage Postgres

### 2.1 Posture

| Property           | Value                                                                                                | Why                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Listen address     | `listen_addresses = 'localhost'` — loopback v4/v6 only                                               | The API and the backup/restore scripts are on the same box (ADR-0043 d4)                                               |
| Transport          | TCP over loopback (`pg`/node-postgres) plus the unix socket                                          | `DATABASE_URL=postgres://kajianq:…@127.0.0.1:5432/kajianq`                                                             |
| Auth               | `scram-sha-256` on loopback v4/v6; no wider `pg_hba` rules                                           | A password is required over TCP                                                                                        |
| TLS                | **not configured**                                                                                   | Traffic never leaves the host; a second host needing the database is a new decision (TLS + `pg_hba`), not an edit here |
| Version            | Postgres 17 (Debian 13 package), cluster `17/main`                                                   | The contract suite and the restore drill pin `pgvector/pgvector:pg18` as the image they test against                   |
| Extensions         | `vector` (pgvector 0.8), installed by the engine migration (`CREATE EXTENSION IF NOT EXISTS vector`) | Retrieval's HNSW cosine indexes need it                                                                                |
| Statement logging  | `log_statement = 'none'`, `log_min_duration_statement = -1`                                          | A chat question is personal data (Art. 9 adjacent) and does not belong in an ops log                                   |
| Connection logging | `log_connections = on`, `log_disconnections = on`                                                    | Incident triage without capturing content                                                                              |
| Log files          | one per day under `/var/log/postgresql`, 14-day window                                               | Rotated by `/etc/logrotate.d/kajianq-postgres` (daily, `maxsize 100M`, `copytruncate`)                                 |

The full posture file is
[`provision/vps/postgres/99-kajianq.conf`](../provision/vps/postgres/99-kajianq.conf),
installed into `/etc/postgresql/<version>/main/conf.d/` by `apply.sh`.

### 2.2 Where the password lives

The `kajianq` role's password was generated **on the box**, stored only in
`/etc/kajianq/db-password` (root:root 0600), and consumed into `api.env` and
`backup.env`. It never left the box in a log or a diff. To rotate it: `ALTER
ROLE kajianq WITH PASSWORD '…'` via `sudo -u postgres psql`, then update the
password in `/etc/kajianq/api.env` and `/etc/kajianq/backup.env` and restart
`kajianq-api.service` (a rotated password otherwise fails the next chat call and
the next backup).

### 2.3 Migrations

Three migration sets share one database and one `schema_migrations` ledger;
migration **names** are unique across all three directories:

| Set         | Directory                            | `up` script            | `status` script            |
| ----------- | ------------------------------------ | ---------------------- | -------------------------- |
| engine      | `packages/infra/migrations`          | `bun run db:up`        | `bun run db:status`        |
| domain pack | `packages/kajianq-domain/migrations` | `bun run db:up:domain` | `bun run db:status:domain` |
| product API | `apps/api/migrations`                | `bun run db:up:api`    | `bun run db:status:api`    |

Convenience: `bun run db:status:all` and `bun run db:up:all` (in that order),
`bun run db:down:all` in reverse. Each file is applied inside an explicit
`BEGIN … COMMIT` with its ledger row in the same transaction, so a failed
statement rolls the whole migration back. The CLI runs over a plain `pg` `Pool`
(TCP) because migrations need session transactions.

From the box (loopback, so no tunnel):

```bash
DATABASE_URL="postgres://kajianq:<pw>@127.0.0.1:5432/kajianq" bun run db:status:all
DATABASE_URL="postgres://kajianq:<pw>@127.0.0.1:5432/kajianq" bun run db:up:all
```

`db:status:all` must show every migration applied after a restore (the archive's
`schema_migrations` ledger is the source of truth for what it already carries).

### 2.4 Snapshots (ADR-0038 — the paid corpus's durability layer)

`bun run db:snapshot` operates on whatever `DATABASE_URL` names, so the source
is just a URL — the CLI carries no vendor in its configuration.

```bash
create <label> | verify <label> | require <label> | list | download <label> --out <path> | restore-plan <label>
```

- **A whole-database `pg_dump`** (custom format), plus a manifest with sha256,
  byte size, per-table row counts, applied migrations, git sha, and a `privacy`
  block. Uploaded through the `ObjectStore` seam (R2 credentials: `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`).
- **`create` computes whether the archive carries personal data** from its row
  counts and **refuses** to write such an archive unless the target's posture is
  asserted. Two escapes, both explicit:
  - `KAJIANQ_SNAPSHOT_ENCRYPTED_AT_REST=true` — the operator asserts the target
    is encrypted at rest (the post-cutover path);
  - `KAJIANQ_SNAPSHOT_PLAINTEXT_ACKNOWLEDGED=true` — the operator acknowledges
    the transitional plaintext exposure ADR-0043 decision 5 records (the
    pre-cutover R2 path).

  Neither set ⇒ `refused`. There is no third snapshot tool: the encrypted-at-rest
  path is the GDPR-D backup tooling (§2.5), and ADR-0044's alternatives section
  records why a second one was rejected.

- **Labels are immutable.** A label that already exists is never overwritten —
  take a new label instead. The regex is lowercase letters, digits, and dashes
  (`^[a-z0-9][a-z0-9-]{2,60}$`); the `date -u +%Y%m%dT%H%MZ` shape is **not**
  lowercase-safe, so write labels with a lowercase `t`/`z` (the on-host record
  hit this twice).
- **`verify` partitions tables**: corpus and schema-identity tables
  (`doc_parents`, `doc_children`, `aligned_pairs`, `schema_migrations`) must
  match the live database **exactly**; ledger/personal tables legitimately
  "moved on" and are only reported. That exemption is privacy-relevant, not
  ergonomic: a red verify is **never** "fixed" by re-snapshotting without the
  personal tables, and a label is never deleted to reduce exposure — the
  paid-corpus durability guardrail outranks a cosmetic green.
- **`require <label>`** gates the start of any money-spending ingest.
- **`restore-plan <label>`** prints the exact restore commands.

The two labels that bracket the GDPR-E transfer — cite them together as
ADR-0038 evidence:

- **`pre-cutover-20260920t1302`** — source Neon, verified before any transfer;
- **`post-cutover-20260920t1316`** — target VPS (pg 17.11), verified through the
  loopback-only tunnel.

Both manifests report 34,389 total rows with equal per-table counts (zero ledger
drift: nothing ran between the two steps). A third label,
`post-cutover-20260920t1306`, exists and is **mislabeled history**: it was
created by a stale local checkout whose CLI still read `NEON_DATABASE_URL`, so
it came from Neon, not the VPS. Labels are immutable, so it stays with that note
as its correction rather than being deleted.

**Retention.** The newest verified snapshot per environment is retained; every
**superseded** snapshot carrying personal data is deleted **30 days after** its
successor was verified — an explicit deletion by label after a documented
window, never an overwrite (ADR-0043 decision 5).

### 2.5 Backups (restic, client-side encrypted)

The GDPR-D durability layer, distinct from the portable snapshot above:
[`provision/vps/backup/kajianq-backup.mjs`](../provision/vps/backup/kajianq-backup.mjs),
scheduled by `kajianq-backup.timer` at **03:15** nightly (`Persistent=true`, so
a powered-off night is caught up at the next boot). It is oneshot and runs as
root (it reads the repository key and dumps the database).

What one run does: `pg_dump --format=custom` into a private temp dir → record a
manifest (size, sha256, per-table counts, source host/database **name only**) →
`restic backup` (encrypts client-side with the repository key, so the target
stores ciphertext only) → `restic forget --keep-daily 30 --prune` — the 30-day
rolling window and the **only** deletion path. The plaintext dump is removed in
a `finally`; a `PrivateTmp` isolates it for the run's duration.

Configuration lives in `/etc/kajianq/backup.env`:

| Key                    | Today                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESTIC_REPOSITORY`    | `/srv/kajianq-backups/restic` — **local filesystem on the same box**. An external, off-box target is ticket-tracked; until then the box's own disk is the only copy, which is a real gap, not a detail. |
| `RESTIC_PASSWORD_FILE` | `/etc/kajianq/restic.pass`, root 0600, generated on the box. **Losing it makes every backup unrecoverable; leaking it makes every backup plaintext.** Keep a copy in the owner's password manager.      |
| `PGDATABASE_URL`       | the loopback `kajianq` URL; decomposed into libpq `PG*` env vars so the password never reaches the process table.                                                                                       |

The script **refuses to run** when the password file is group- or
world-readable: a world-readable repository key silently undoes the encryption
it exists to provide. The target must never be a free tier (the register rule) —
the repository holds a full-database dump carrying chat content and feedback.

Operate it:

```bash
sudo sh -c '. /etc/kajianq/backup.env && restic -r "$RESTIC_REPOSITORY" snapshots'
sudo sh -c '. /etc/kajianq/backup.env && bun provision/vps/backup/kajianq-backup.mjs --label first-run'
sudo systemctl list-timers kajianq-backup.timer
```

One-time repository init (mints the key) is
[`docs/VPS-HARDENING-RUNBOOK.md`](./VPS-HARDENING-RUNBOOK.md) step 4 and must
happen **before** the timer's first scheduled fire.

### 2.6 The restore drill, and its one gotcha

The executable test of "a restore re-applies erasure"
([`provision/vps/backup/restore-drill.mjs`](../provision/vps/backup/restore-drill.mjs),
also run by `.github/workflows/vps-restore-drill.yml` against a scratch
`pgvector` service container). It creates and drops its own two scratch
databases and touches no live store. It asserts, in order: the restored target
**does** hold the erased rows (the negative control — without it the drill could
pass while testing nothing), then that re-applying the reclamation and the
Art. 17 cascade makes the restored target match the live store.

```bash
sudo sh -c '. /etc/kajianq/backup.env && \
  bun provision/vps/backup/restore-drill.mjs \
    --admin-url "postgres://postgres@127.0.0.1:5432/postgres"'
```

**The gotcha.** The drill is self-contained by design and sets its own
`RESTIC_PASSWORD` — but restic gives `RESTIC_PASSWORD_FILE` **precedence**. Run
the drill from a shell that has sourced the production `backup.env` (which the
runbook's own example does) and the drill's `restic init` encrypts with the
_production_ key; its backup child then fails with restic exit 12. Run it with
the inherited variables stripped:

```bash
env -u RESTIC_REPOSITORY -u RESTIC_PASSWORD_FILE -u PGDATABASE_URL \
  bun provision/vps/backup/restore-drill.mjs --admin-url "postgres://postgres@127.0.0.1:5432/postgres"
```

A code-level guard (the drill refusing an inherited `RESTIC_PASSWORD_FILE`) is
worth a follow-up; today the discipline is the operator's. Pass `--keep` to
inspect the scratch databases and the plaintext dump instead of having them
removed.

### 2.7 Restoring for real

```bash
sudo sh -c '. /etc/kajianq/backup.env && \
  bun provision/vps/backup/kajianq-restore.mjs \
    --label <label> --target-url postgres://…/kajianq_restored'
```

[`kajianq-restore.mjs`](../provision/vps/backup/kajianq-restore.mjs) cannot
write to the live database, by construction:

- `--target-url` is **required** and `PGDATABASE_URL` is required with it; the
  target must not name the same database (compared by normalized location —
  host, port, database name — not raw string). That refusal is the whole point:
  restoring over the live store would resurrect data the live store had already
  erased.
- The archive is decrypted by restic, **re-hashed**, and compared to the
  manifest **before** anything is restored — a corrupted archive stops there
  instead of producing a half-restored scratch database.
- After the restore it re-runs the reclamation and the Art. 17 cascade for the
  affected window (`--erase-user <id>` when a subject request arrived after the
  backup), because otherwise a restored row silently resurrects deleted data
  (ADR-0043 decision 4). The cascade statement is bound as a psql variable and
  pinned by test against production `deleteUserCascade`, so the restore path
  cannot drift from the live erasure.

**After a real restore:** re-run the reclamation for the affected window,
verify the scratch database, and only then repoint `DATABASE_URL` at it.
Backups are **never** used to answer a subject request.

### 2.8 Reaching the database from elsewhere

The listener is loopback-only, so any external access is an **ssh tunnel** — the
tunnel is the loopback peer. This is the pattern for the post-cutover snapshot,
for the Staging workflow's Golden Set smoke, and for any ad-hoc query:

```bash
# keep this shell open for as long as the tunnel is needed
ssh -N -L 15433:127.0.0.1:5432 <user>@<host>
# elsewhere: DATABASE_URL=postgres://kajianq:<pw>@127.0.0.1:15433/kajianq
```

The Staging workflow does exactly this (`-L 15433:127.0.0.1:5432`), which is why
`STAGING_DATABASE_URL` must name port **15433** and not 5432. The cutover runbook
uses the same shape on another local port. Nothing wider should ever be opened —
a second host needing direct database access is a new decision (TLS + `pg_hba`),
recorded before it is configured.

## 3. What hardening is applied

The summary; the step-by-step is
[`docs/VPS-HARDENING-RUNBOOK.md`](./VPS-HARDENING-RUNBOOK.md), and every file
below is config-as-code under [`provision/vps/`](../provision/vps/) placed by
`apply.sh` (idempotent, fail-closed, `--dry-run` available).

| Area                         | What is applied                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service account & sandboxing | `kajianq` (nologin); `kajianq-api.service` runs with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `ProtectKernel*`, `ProtectControlGroups`, `RestrictAddressFamilies`, `RestrictNamespaces`, `LockPersonality`, `MemoryDenyWriteExecute`, `ReadWritePaths=/srv/kajianq/api`; `Restart=on-failure`, `RestartSec=5` |
| Restart drain                | `TimeoutStopSec=300s` matching the code's bounded SIGTERM drain (`DRAIN_TIMEOUT_MS = 300s`) and nginx's `proxy_read_timeout 300s`, so an in-flight SSE answer is never cut mid-answer; `KillMode=mixed` SIGTERMs the main process (the drain target) only                                                                                                      |
| Reverse proxy                | nginx owns :80/:443 (the bootstrap's Caddy is retired). Access-log format is minimal by construction: client IP, timestamp, request line, status, bytes, correlation id, request time — **no** user-agent, referrer, or `$remote_user`. Plain :80 redirects and logs nothing, so the IP-bearing log is confined to the single TLS server block                 |
| TLS                          | Let's Encrypt through certbot (`certbot certonly --nginx`); certbot owns renewal                                                                                                                                                                                                                                                                               |
| Firewall                     | ufw active, default deny in / allow out, exactly 22/80/443 open (v4+v6)                                                                                                                                                                                                                                                                                        |
| SSH                          | `PermitRootLogin no`, `PasswordAuthentication no`; access by key only                                                                                                                                                                                                                                                                                          |
| Log retention                | proxy + Postgres logs: daily, `maxsize 100M`, gzip, **14 days total** (current day + 13 rotated segments), nginx reopened on SIGUSR1 and Postgres `copytruncate`; API structured logs capped by journald at **14 days / 512M** (`Storage=persistent`)                                                                                                          |
| Postgres                     | loopback-only listener; no statement text in logs; 14-day rotated files (§2.1)                                                                                                                                                                                                                                                                                 |
| Backups                      | restic client-side encryption, 30-day rolling `forget --prune`, key outside the repo, group/world-readable key refused (§2.5)                                                                                                                                                                                                                                  |
| Secrets                      | never in the repository and never in `argv`: every credential arrives through a root-owned `EnvironmentFile` or the environment, and both scripts refuse to source a loosely-permissioned env file                                                                                                                                                             |
| Security headers             | `/v1/*` gets the full CSP/HSTS/nosniff/X-Frame-Options/Permissions-Policy/COOP/CORP set from `@app/hardening` (`secureHeaders`). Static paths are served by nginx, so the same values are set in the nginx site block's static `location /` (PR #197) — confirm with `curl -sI https://<host>/` and expect the same seven headers                              |
| OS maintenance               | `unattended-upgrades` for security patches (installed at baseline)                                                                                                                                                                                                                                                                                             |
| Config as code               | `apply.sh` renders and installs every file above, validates the nginx config (`nginx -t`) and both logrotate stanzas (`logrotate --debug`) as part of the run, and **enables** the units without starting the API — a box that comes up hardened rather than accidentally serving                                                                              |

`apply.sh` is safe to re-run: it overwrites each file from the repository and
enables already-enabled units. It **fails closed**: a half-applied hardening
config is worse than an unapplied one, because it looks done.

## 4. Monitoring — where it stands

What exists today, and what notices a problem:

| Signal                        | Mechanism                                                                                                                                                | Notices                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| API process death             | `Restart=on-failure` + `RestartSec=5` on `kajianq-api.service`; `systemctl status kajianq-api`                                                           | systemd restarts it; a human sees it in `status`/journald |
| API structured logs           | JSON to stdout → journald, correlation id and no IP; 14-day/512M cap                                                                                     | greppable by correlation id, bounded on disk              |
| Proxy + Postgres logs         | 14-day rotated files                                                                                                                                     | incident triage, bounded                                  |
| Nightly jobs ran              | `systemctl list-timers kajianq-cron.timer kajianq-backup.timer`; `journalctl -u kajianq-cron` / `-u kajianq-backup`; a deploy runs the cron oneshot once | a missed or failed run is visible **if someone looks**    |
| Backups exist                 | `restic snapshots` in the repository                                                                                                                     | on demand                                                 |
| Post-cutover health (staging) | The `Staging` workflow's `post-deploy-checks` job: Golden Set smoke + ZAP baseline (`fail_action: true`) + Schemathesis fuzz, on every main merge        | a code-bearing push, not a clock                          |
| TLS expiry                    | certbot's renewal                                                                                                                                        | certbot only; no alert if renewal stops                   |

**The gaps, stated plainly.** Nothing on or off the box proactively tells the
owner that something is wrong:

- **No external uptime probe.** If the box dies, nothing off the box notices —
  an external probe pinging `GET /v1/health` is the only layer that can.
- **No disk-space alert.** Postgres data and the restic repository both grow on
  the same disk, and neither has a threshold alarm.
- **No TLS-expiry alert.** Renewal failing silently is a hard outage with a
  visible cause nobody is watching.
- **No backup-failure or missed-day alert.** The 30-day durability guarantee is
  only as real as the schedule.
- **No host metrics collection.** CPU, memory, disk growth, connection counts,
  and lock waits are not collected: no metrics agent is installed and nothing
  reports anywhere (the cutover record's package list is nginx, Postgres +
  pgvector, certbot, restic, Bun — no collector).
- **No dashboards.** Only `systemctl`, `journalctl`, `restic`, and `psql`.

This is tracked by **issue #194** (_Observability: health/monitoring dashboard +
Lark alerts for the VPS_), which carries a research-first mandate — survey the
current landscape before choosing tools — and the guardrails a candidate must
satisfy: alerts must carry health signals only (never chat content, question
text, trace data, or IP addresses), provisioning stays under `provision/vps/`
(ADR-0044 decision 3), an alert sink should be a seam (a webhook URL in env), and
monitoring must not create an unbounded personal-data-adjacent log surface. Issue
#196 tracks the ZAP baseline findings.

## 5. Common operations at a glance

| I want to…                           | Do this                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Deploy the current `main` to staging | push a code-bearing commit to `main` (or dispatch the `Staging` workflow)                               |
| Deploy a specific ref manually       | dispatch `Deploy to VPS` with `environment: staging`, then again with `prod` (approval)                 |
| Deploy from the deploying machine    | `provision/vps/deploy/deploy.sh --env /etc/kajianq/deploy.env`                                          |
| See what a deploy would do           | `provision/vps/deploy/deploy.sh --dry-run`                                                              |
| Apply/refresh hardening              | `sudo provision/vps/apply.sh --env /etc/kajianq/proxy.env` (idempotent)                                 |
| Check migrations                     | `DATABASE_URL=… bun run db:status:all` (§2.3)                                                           |
| Take a snapshot                      | `DATABASE_URL=… bun run db:snapshot create <lowercase-label>` with the posture flag (§2.4)              |
| Verify a snapshot                    | `bun run db:snapshot verify <label>`                                                                    |
| Take a backup now                    | `sudo sh -c '. /etc/kajianq/backup.env && bun provision/vps/backup/kajianq-backup.mjs --label <label>'` |
| List backups                         | `sudo sh -c '. /etc/kajianq/backup.env && restic snapshots'`                                            |
| Drill a restore                      | §2.6, with the inherited `RESTIC_*`/`PG*` stripped                                                      |
| Restore for real                     | `kajianq-restore.mjs --label … --target-url <scratch>` (§2.7)                                           |
| Reach the DB from elsewhere          | ssh tunnel (§2.8), port 15433 to match the CI convention                                                |
| Read the API logs                    | `sudo journalctl -u kajianq-api -f` (non-root users need `systemd-journal` group membership)            |
| Check the schedules                  | `systemctl list-timers kajianq-cron.timer kajianq-backup.timer`                                         |

## Related

- [`adr/0044-vps-serving-path-cutover.md`](../adr/0044-vps-serving-path-cutover.md) — the serving path, the deployer's home, the single-shot cutover
- [`adr/0043-netcup-vps-hosting-gdpr-posture.md`](../adr/0043-netcup-vps-hosting-gdpr-posture.md) — the register, retention values, backups
- [`adr/0038-corpus-snapshot-durability-guardrail.md`](../adr/0038-corpus-snapshot-durability-guardrail.md) — the snapshot discipline
- [`docs/VPS-HARDENING-RUNBOOK.md`](./VPS-HARDENING-RUNBOOK.md) — the hardening steps and the restore test
- [`docs/VPS-CUTOVER-RUNBOOK.md`](./VPS-CUTOVER-RUNBOOK.md) / [`RECORD`](./VPS-CUTOVER-RECORD.md) — the executed migration and its evidence
- [`docs/GDPR-ARTICLE-30-RECORD.md`](./GDPR-ARTICLE-30-RECORD.md) — retention values and TOMs this box implements
