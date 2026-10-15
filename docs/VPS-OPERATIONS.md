# VPS operations — the running box

The operator's manual for the netcup VPS that serves KajianQ: how to deploy,
how to manage Postgres, what hardening is applied, and what the monitoring story
is today. This is the **as-is** document for the box that is running, not the
plan for getting there.

The VPS document set is now three: a **setup** guide, this **operations**
manual, and the **evidence** record. Three earlier documents were retired once
the cutover executed — `VPS-BASELINE-SETUP.md` (its bootstrap is now the setup
guide's §1, with nginx instead of the baseline's Caddy),
`VPS-CUTOVER-RUNBOOK.md` (a one-shot migration off Cloudflare + Neon; its
acceptance-criteria checklist and the vendor-neutral data-move procedure moved
into the record and the setup guide respectively), and `neon-sizing-issue-4.md`
(a pointer stub superseded by ADR-0020). Their full text stays in git history.

| Document                                                                                        | Answers                                                                                                        |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **this file**                                                                                   | How do I operate the box that is running?                                                                      |
| [`docs/VPS-SETUP.md`](./VPS-SETUP.md)                                                           | How do I stand up an instance of my own from a bare VPS — and what hardening does it carry?                    |
| [`docs/VPS-CUTOVER-RECORD.md`](./VPS-CUTOVER-RECORD.md)                                         | What actually ran on the box, in execution order (append-only), and the #181 acceptance-criteria walk-through. |
| [`adr/0044-vps-serving-path-cutover.md`](../adr/0044-vps-serving-path-cutover.md)               | Why the serving path is a Bun process behind nginx.                                                            |
| [`adr/0043-netcup-vps-hosting-gdpr-posture.md`](../adr/0043-netcup-vps-hosting-gdpr-posture.md) | Register, retention values, GDPR posture.                                                                      |

The repository is **public**. Nothing below contains a real hostname, IP
address, credential, or user name — `<host>`, `<user>`, `<IP>` are placeholders.
The real values live in the owner's password manager and in `/etc/kajianq/*.env`
(mode 0600) on the box and on the deploying machine.

Loading corpus data onto this box's database is its own runbook:
[`docs/CORPUS-INGEST.md`](./CORPUS-INGEST.md) — the local, tunnel-based ingest
sequence with the ADR-0038 snapshot gate.

## 0. What runs on the box

```
Internet
   │  (kajianq.ahaqqu.com — a DNS-only A record at the domain's own nameservers;
   │   no CDN proxy sits in the serving path, per ADR-0044 decision 4, §1.6)
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
Neon are **decommissioned** (2026-09-21, runbook step 7): the Workers runtime,
static-asset serving, and Durable Objects are deleted, the Neon project is
deleted, and no serving traffic transits Cloudflare. The only Cloudflare
artifact retained is the R2 bucket `kajianq-raw-staging` — the corpus raw
exports and snapshot dumps (provenance archive, ADR-0038 decision 4); nothing
at runtime reads it.

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
3. **Restart.** `sudo systemctl restart kajianq-api.service`, then a plain
   (unprivileged) `systemctl is-active --quiet` so a unit that died on start
   fails the deploy immediately, then `sudo systemctl start kajianq-cron.service`
   once, so a rotated env var or a missing key fails the deploy now rather than
   silently at 03:17. The timer itself is not restarted — its schedule does not
   depend on the shipped code. Both `sudo` calls are covered by exactly two
   grants (§1.5); the `is-active` check needs none.
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

| Trigger                                                      | GitHub environment       | Where it comes from                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push to `main` with at least one file outside `paths-ignore` | staging                  | `Staging` workflow's `deploy` job (`paths-ignore` skips a **docs-only or tests-only** push, where a deploy plus its paid smoke would be pure spend) |
| Manual dispatch of `Staging`                                 | staging                  | `workflow_dispatch`, with `eval_smoke_size` / `eval_budget_micro_usd` knobs                                                                         |
| Manual dispatch of `Deploy to VPS`                           | staging or prod (choice) | `workflow_dispatch`, `environment` input                                                                                                            |
| Manual dispatch of `Deploy to VPS` calling `workflow_call`   | staging                  | This is how `Staging` invokes it — one implementation, so the two cannot drift                                                                      |

That column names a **GitHub environment**, not a deployment
environment on a host. Both `staging` and `prod` deploy to **the one box** (§0):
`deploy.sh` uses a single `DEPLOY_ROOT` and nginx serves one `root`, so the
choice selects that environment's vars/secrets — and `prod`'s approval gate —
and nothing else. **No production deployment is provisioned** (ADR-0044
decision 2; deferred 2026-10-03): the box is labeled `staging`, provisioning production is
deferred rather than pending, and a `prod` dispatch today deploys the same box
the `staging` environment does.

**Order and approval.** Deploys are run staging first, then prod, in one step
each — the engineering order of the single-shot cutover (ADR-0044 decision 2),
and there is no second host for a "prod" run to reach. The workflow sets
`environment: ${{ inputs.environment }}`, so a **prod dispatch runs against the
`prod` environment** — that environment's approval rule is where the owner's
sign-off for a production-targeted deploy belongs (`deploy-vps.yml`'s own header
comment records this as the intent), and its own
`VPS_HOST`/`VPS_USER`/`VPS_PUBLIC_URL` vars and `VPS_DEPLOY_SSH_KEY` secret must
be configured for it. Staging and prod therefore carry their own values under
one repository, and today nothing requires their `VPS_HOST` to differ: there is
no second host to name.

> **The environment and its approval rule are owner setup, not code.** The
> workflow names the environment; whether a required reviewer is attached is
> GitHub configuration outside this repository. Confirm it before relying on it
> (`gh api repos/<owner>/<repo>/environments`): if no `prod` environment exists
> or it carries no protection rule, a prod dispatch has **no approval gate**,
> and the runbook's "owner sign-off" step is not actually enforced.

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
same-vendor owner decision; ADR-0044 decision 7) and `GEMINI_PAID_API_KEY` (the embedder head). Without
them the reviewer or embedder stage fails with a typed error while `/v1/health`
and anonymous minting stay green — so the deploy's smokes alone do not prove
they are present.

`KAJIANQ_WEB_ROOT=/srv/kajianq/web` is load-bearing. The unit's
`WorkingDirectory` is `/srv/kajianq/api`, so the code's inline default, the
literal value

```text
./apps/web/dist
```

resolves to a path that does not exist on the deployed tree and every SPA route
would 503 while health stayed green.

### 1.4 GitHub variables and secrets

Repo-level values the workflows read (nothing here is in the repository):

| Kind   | Name                      | Read by                                        | Purpose                                                                    |
| ------ | ------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| var    | `VPS_HOST`                | `deploy-vps.yml` → `KAJIANQ_DEPLOY_HOST`       | the server (or an ssh-config alias)                                        |
| var    | `VPS_USER`                | `deploy-vps.yml` → `KAJIANQ_DEPLOY_USER`       | the deploy identity — `kajianq-deploy` (§1.5)                              |
| var    | `VPS_PUBLIC_URL`          | deploy smoke, Staging smoke, ZAP, Schemathesis | the public base URL                                                        |
| var    | `VPS_ROOT`                | `deploy-vps.yml` → `KAJIANQ_DEPLOY_ROOT`       | the deployed tree (default `/srv/kajianq`)                                 |
| secret | `VPS_DEPLOY_SSH_KEY`      | deploy + staging tunnel                        | a dedicated ed25519 deploy key, public half in the box's `authorized_keys` |
| secret | `STAGING_DATABASE_URL`    | Staging Golden Set smoke                       | the VPS Postgres loopback URL, **through the tunnel port** (§2.8)          |
| secret | `RATE_BYPASS_PRIVATE_KEY` | Staging Schemathesis fuzz                      | the purpose-locked bypass token (ADR-0041)                                 |

`deploy-vps.yml` fails at a named "Require the deploy access" step when a var or
the key is missing — an actionable failure rather than a silent no-op. The
private key is written to a runner-local file the job removes when it ends.

**Legacy variables removed (step 7 executed).** `STAGING_URL` is deleted;
`PROD_URL` is re-pointed at the VPS's public origin
(`https://kajianq.ahaqqu.com` since the hostname switch of 2026-09-29, §1.6) —
no workflow reads either, the occurrences of the name `STAGING_URL` in
`staging.yml` are that workflow's own local shell variable fed from
`vars.VPS_PUBLIC_URL`. The Worker-era secrets (`CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `NEON_API_KEY`, `NEON_DATABASE_URL`) are deleted
from the GitHub secret store. What the workflows actually consume is the
`vars.VPS_*` set above (repo-level) plus the `prod` environment's
environment-scoped copy of the same four (`VPS_HOST`, `VPS_USER`, `VPS_ROOT`,
`VPS_PUBLIC_URL`) and its `VPS_DEPLOY_SSH_KEY` secret.

**The `prod` environment (owner sign-off gate).** A prod dispatch of
`Deploy to VPS` targets the `prod` environment, which carries a
required-reviewer protection rule (the owner) and a protected-branch policy —
the approval is the owner's sign-off for a production-targeted deploy
(ADR-0044 decision 2). Its `VPS_*` variables and `VPS_DEPLOY_SSH_KEY` are
environment-scoped, so staging and prod carry their own credentials under one
repository — and both point at the **one box** (§1.2), because no production
deployment is provisioned (ADR-0044 decision 2; deferred 2026-10-03).

### 1.5 The permission model (deploy identity ↔ `kajianq`)

Three distinct identities, deliberately:

- **`kajianq`** — a system account with `nologin`, created by `apply.sh`. It is
  the user both `kajianq-api.service` and `kajianq-cron.service` run as, and it
  **reads** the deployed tree through the 0755 world bits. It cannot log in, is
  not in `sudo`, and does not own the deployed tree — the API never writes to
  it (nothing in `apps/api` writes to disk), so it needs no write access there.
- **`kajianq-deploy`** — the deploy identity, created by `apply.sh`. A
  dedicated unprivileged login account, not a human admin login: CI's deploy
  key belongs to it, so the owner's admin account is not the credential a
  workflow holds. Its authorization is **exactly two commands**, installed as
  code from [`provision/vps/sudoers/kajianq-deploy`](../provision/vps/sudoers/kajianq-deploy)
  by `apply.sh` (at `/etc/sudoers.d/kajianq-deploy`, root:root 0440, and only
  after `visudo -cf` parses it):
  - `systemctl restart kajianq-api.service`
  - `systemctl start kajianq-cron.service`

  By absolute path, no wildcards, no shell, no `ALL`. The read-only
  `systemctl is-active` check is deliberately **not** granted — unit state is
  world-readable, so the deploy runs it without `sudo`. The account also
  **owns the deployed tree** (`/srv/kajianq/{api,web}`), which is what lets
  `rsync --delete` write it and re-stamp times on unchanged files without any
  group-write grant. It cannot read `/etc/kajianq/*.env` (root:root 0600), so
  the provider keys and database password are not reachable from its session.

  The name is fixed rather than configurable, because sudoers grants are
  per-username: the account, the grant file, and CI's `VPS_USER` variable must
  name the same user, and `tests/scripts/vps-hardening.test.mjs` fails the build
  when they drift. `apply.sh` additionally refuses to install a grant that does
  not name the account it created.

- **root** — `apply.sh`, `kajianq-backup.service` (it reads the restic key and
  dumps the database), and the one-time repository init.

> **Why the deploy identity exists (and why it is pinned by test).** Before the
> 2026-09-21 amendment the deploy ran as the owner's admin login on a temporary
> `NOPASSWD:ALL` rule installed for the cutover session, and the grant §1.5
> described had never actually been installed. Removing the temporary rule
> therefore broke the next push to `main` at the restart step — `sudo: a
password is required`, after the tree had already shipped (Staging run
> 35548824035). The fix moved the grant into the repository and put executable
> pins on it, so the host precondition and the deploy script can no longer
> disagree silently. Record: ADR-0044 decision 6.

`rsync --chmod=D755,F644` normalizes what lands: directories 0755, files 0644.
The API bundle is not written by the service account, so a deploy cannot leave a
stale file the process still holds — the restart in step 3 is what swaps the
code.

### 1.6 The public hostname (and how to change it)

The box serves **`https://kajianq.ahaqqu.com`**. It was cut over on the
`62.83.35.220.sslip.io` wildcard name and moved to the custom domain on
2026-09-29, which **retired** the old name — one canonical public origin, no
alias server block. The executed migration's own record
([`docs/VPS-CUTOVER-RECORD.md`](./VPS-CUTOVER-RECORD.md)) still names sslip.io:
that is the name the recorded steps ran under, and a record is not rewritten
when the world moves on.

The name is configuration, not code, and it lives in exactly three places:

| Where                    | Key                                                     | Read by                                                                      |
| ------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `/etc/kajianq/proxy.env` | `KAJIANQ_DOMAIN`, `KAJIANQ_TLS_CERT`, `KAJIANQ_TLS_KEY` | `apply.sh`, which renders them into nginx's `server_name`/`ssl_certificate*` |
| `/etc/kajianq/api.env`   | `ALLOWED_ORIGINS`                                       | the API's strict CORS allowlist (§1.3)                                       |
| GitHub variable          | `VPS_PUBLIC_URL` (§1.4, **both** scopes)                | deploy smoke, Staging smoke, ZAP, Schemathesis                               |

The PWA needs no change either way: it calls the API same-origin
(`apps/web/src/lib/api.ts` → `API_BASE = "/v1"`), and the API additionally
accepts its own origin (`resolveCorsOrigin`), so a hostname switch cannot break
the served app the way a split UI/API host would.

**The other project on this box must keep serving.** Gunbatte Royale
(`gunbatte.ahaqqu.com`, `play.gunbatte.ahaqqu.com` → `gunbatte.service` on
:8321) shares nginx, certbot, and Postgres, so a hostname switch is written to
touch none of its pieces:

- `apply.sh` renders **only** `/etc/nginx/sites-available/kajianq.conf` (from
  the repo template) and symlinks it; `gunbatte.conf` is never read, rewritten,
  or removed, and its `server_name`s never match this project's names.
- Certbot's lineage is per-name: this project's certificate lives under
  `/etc/letsencrypt/live/<this-host>/`, gunbatte's under
  `/etc/letsencrypt/live/play.gunbatte.ahaqqu.com/`. Renewal and
  `certbot delete` act on one lineage each, so retiring our old name cannot
  touch theirs.
- Neither `/srv/kajianq` (the deploy's `rsync --delete` target) nor
  `/etc/kajianq/*.env` overlaps gunbatte's static root
  (`/home/kajianq-deploy/gunbatte/website`) or its unit.
- What is box-wide and therefore a real, if momentary, effect: nginx **reloads**
  (graceful — established connections drain, no dropped request) and `apply.sh`
  restarts **Postgres** and **journald** (≈1 s each, so a shared database
  connection may blip). `gunbatte.service` itself is never restarted.

**The name must resolve directly to the box.** The nginx block overwrites
`CF-Connecting-IP` with `$remote_addr` and the rate limiter trusts that header,
so a CDN proxy in front of the origin would hand the limiter an edge address and
collapse per-IP metering into one global bucket (ADR-0044 decision 4). The
record is therefore DNS-only; there is no proxy toggle to remember, and a
hostname whose DNS _is_ proxied must gain `ngx_http_realip_module`
configuration first.

To move the box to another name (root on the box):

```bash
# 0. Insurance on a shared box: with --webroot certbot edits no server block,
#    and this snapshot makes that claim checkable afterwards (the compare in the
#    checks below lists every file that changed under /etc/nginx).
sudo tar czf "/root/nginx-config-$(date +%F).tgz" -C /etc nginx

# 1. Certificate first: step 4 renders a server block that names these files,
#    and `nginx -t` fails on a missing certificate. This box shares :80 with
#    gunbatte, so use --webroot: the challenge is served from the stock
#    default vhost's root (/var/www/html) and certbot edits no server block at
#    all. (`--nginx`, the setup guide's command on a single-tenant box, would
#    temporarily rewrite whichever block it picks.)
sudo certbot certonly --webroot -w /var/www/html -d <new-host>

# 2. The proxy's own identity — the domain plus the two paths certbot printed.
sudoedit /etc/kajianq/proxy.env     # KAJIANQ_DOMAIN, KAJIANQ_TLS_CERT, KAJIANQ_TLS_KEY

# 3. The API's allowlist — the origin exactly: scheme included, no trailing slash.
sudoedit /etc/kajianq/api.env       # ALLOWED_ORIGINS=https://<new-host>

# 4. Refresh the checkout apply.sh renders from, then render + validate + reload
#    (idempotent; it also re-installs the units and the log-rotation stanzas, and
#    restarts Postgres and journald — a second of downtime, not a deploy). If the
#    pull cannot run (a bundle-transferred tree, no network), the existing
#    checkout still renders the same template: nothing in a hostname switch
#    touches provision/.
sudo git -C /srv/kajianq-src pull --ff-only     # optional; skip if it cannot run
sudo /srv/kajianq-src/provision/vps/apply.sh --env /etc/kajianq/proxy.env

# 5. ALLOWED_ORIGINS is read at process start (systemd EnvironmentFile).
sudo systemctl restart kajianq-api.service
```

Verify from **outside** the box, so the proxy and the certificate are what is
tested rather than the loopback port:

```bash
curl -sS "https://<new-host>/v1/health"                              # {"status":"ok",…}
curl -sS -o /dev/null -w '%{http_code}\n' "https://<new-host>/chat"  # 200 — the SPA, not nginx's 404
echo | openssl s_client -connect <new-host>:443 -servername <new-host> 2>/dev/null |
    openssl x509 -noout -subject -dates                              # CN/SAN is <new-host>
# CORS: the new origin is echoed back, a retired or unknown one gets no header.
curl -sSI -X OPTIONS "https://<new-host>/v1/chat" -H "Origin: https://<new-host>" |
    grep -i '^access-control-allow-origin'
curl -sSI -X OPTIONS "https://<new-host>/v1/chat" -H "Origin: https://<old-host>" |
    grep -i '^access-control-allow-origin'                           # no output
```

And prove the neighbour is untouched — these answered `200` before the switch
and must still answer `200` after it (they are the checks the guarantee above
rests on, not a formality):

```bash
for u in https://gunbatte.ahaqqu.com/ https://play.gunbatte.ahaqqu.com/; do
    printf '%s ' "$u"; curl -sS -o /dev/null -w '%{http_code}\n' "$u"
done
ssh <box> systemctl is-active gunbatte.service     # active
ssh <box> sudo nginx -t                            # syntax ok — no foreign block was touched
# Compare against step 0's snapshot: this project's rendered block should be the
# only entry listed (tar exits 1 when it finds differences — the expected
# outcome here, not a failure).
ssh <box> sudo sh -c 'cd /etc && tar df /root/nginx-config-*.tgz'
```

Then retire the old name and move the variable that names the public origin —
the switch and this step belong to the same sitting, because a
`VPS_PUBLIC_URL` pointing at a name the box does not answer fails every deploy
smoke and Staging run, and so does the reverse (a retired name still named by
the variable):

```bash
# The old certificate — and only AFTER step 4 re-rendered the block: the
# rendered server block names this lineage until then, so deleting it first
# leaves nginx pointing at files that no longer exist. Without the delete,
# certbot's timer keeps renewing a name the box no longer serves, and starts
# failing once DNS stops resolving here.
sudo certbot delete --cert-name <old-host>

# Both scopes: the `prod` environment's copy overrides the repo-level one.
gh variable set VPS_PUBLIC_URL --body "https://<new-host>"
gh variable set PROD_URL       --body "https://<new-host>"
gh api --method PATCH repos/{owner}/{repo}/environments/prod/variables/VPS_PUBLIC_URL \
    -f name=VPS_PUBLIC_URL -f value="https://<new-host>"
```

Finally, prove the CI path end-to-end rather than the box alone: dispatch
**Deploy to VPS** (`environment: staging`) and watch its smoke hit the new URL.
Then record the new origin in §0 and §1.4 here and in the README's environment
table — the repository is where the current name is written down, since the
values that actually serve it are root-only on the box.

### 1.7 The environment label (`APP_ENV`)

**The box is the `staging` environment**, and the live health endpoint says so
(re-measured 2026-10-03 — it read `production` from the cutover until then):

```bash
$ curl -s https://kajianq.ahaqqu.com/v1/health
{"status":"ok","env":"staging","schemaVersion":1,"message":"Hello World"}
```

Production is **not provisioned** — deferred, not pending (ADR-0044 decision 2;
deferred 2026-10-03) — so there is one deployment and `staging` is its label. The GitHub
environments `staging` and `prod` both deploy to it (§1.2); `prod` is the
approval-gated path to the same box, not a second host.

The 2026-09-21 cutover flipped this label to `production`, and
`docs/VPS-CUTOVER-RECORD.md` keeps saying so — a record of executed steps is not
rewritten when the world moves on (§1.6). The label was reverted on the box on
2026-10-03, as root — the file is root-owned and 0600, and the deploy identity
cannot read it (§1.5) — and the restart was clean (`GET /` still answers
`200 text/html`). A fresh rebuild needs none of that: the template now ships
`APP_ENV=staging` (`provision/vps/api.env.example`, installed verbatim by
`docs/VPS-SETUP.md`), so the commands below are the **recovery step for a box
built from the pre-fix template**, or any box whose file still reads
`production`:

```bash
# on the box, as root — only for a file still reading production
sed -i 's/^APP_ENV=production$/APP_ENV=staging/' /etc/kajianq/api.env
systemctl restart kajianq-api.service
curl -s https://kajianq.ahaqqu.com/v1/health   # → "env":"staging"
```

`APP_ENV` is **cosmetic**: it reaches `createRequestContext` →
`createLogger({ service: "api", env: envName, correlationId })`
(`apps/api/src/lib/context.ts`, `packages/infra/src/logger.ts`), so it is the
`env` field on every log line plus the health JSON. It gates no log level, no
filtering, and no privacy or PII behaviour — the `api.env.example` comment
"drives log posture" means exactly that label. Nothing about the running
service's protection changes with it; only what the label says. Provisioning a
production deployment is a new decision and a new host, never this edit.

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
  path is the GDPR-D backup tooling (§2.5), and
  `packages/infra/scripts/snapshot-privacy.mjs` records why a second one was
  rejected (ADR-0043 decision 5).

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

**The schedule's own product is proven** (2026-09-29, closing #214). The
`03:15` fires of 2026-09-26…29 each started with **no operator command between
it and the previous run**, logged `created "daily-<UTC>"` — a line the script
prints only after `restic backup` _and_ `forget --prune` have exited 0 — and
finished `Deactivated successfully` (`ExecMainStatus=0`). Their dump sizes track
the corpus rather than a truncated dump: `359,306,990` bytes on 09-26 (the night
#213's full-corpus load landed), then `669,165,338` / `670,417,700` /
`670,537,885` as it settled, against `133,598,276` before the load. Read the
proof the same way, per night:

```bash
journalctl -u kajianq-backup.service --since "-7 days" | grep -E 'Starting|created|Deactivated'
```

A hardening re-apply (`apply.sh`) re-installs the unit file, which makes the
next deploy demand a fresh run — the gate cannot tell a re-installed identical
unit from a changed one (#320). An operator-started run satisfies that gate but
is **not** the proof above: the proof is a night the timer fired by itself.

Operate it:

```bash
sudo sh -c '. /etc/kajianq/backup.env && restic -r "$RESTIC_REPOSITORY" snapshots'
sudo sh -c '. /etc/kajianq/backup.env && bun provision/vps/backup/kajianq-backup.mjs --label first-run'
sudo systemctl list-timers kajianq-backup.timer
```

One-time repository init (mints the key) is
[`docs/VPS-SETUP.md`](./VPS-SETUP.md) step 4 and must
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
ssh -N -L 15433:127.0.0.1:5432 <your-own-login>@<host>
# elsewhere: DATABASE_URL=postgres://kajianq:<pw>@127.0.0.1:15433/kajianq
```

**The tunnel carries an operator login.** Open it as the account you ssh in as
interactively — `ssh <host> whoami` names it. `kajianq-deploy` is CI's account
instead: `vars.VPS_USER` names it because the workflows log in as it, its
authorized keys are the deploy keys those workflows hold, and its sudo grant is
scoped to what a deploy does. The database side does not depend on which ssh
account carries the tunnel — the role stays `kajianq`.

The **store tunnel** is what the Staging workflow opens (`-L 15433:127.0.0.1:5432`), which is why
`STAGING_DATABASE_URL` must name port **15433** and not 5432. The cutover runbook
uses the same shape on another local port. Nothing wider should ever be opened —
a second host needing direct database access is a new decision (TLS + `pg_hba`),
recorded before it is configured.

## 3. What hardening is applied

The summary; the step-by-step is
[`docs/VPS-SETUP.md`](./VPS-SETUP.md), and every file
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

| Signal                        | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                     | Notices                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| API process death             | `Restart=on-failure` + `RestartSec=5` on `kajianq-api.service`; `systemctl status kajianq-api`                                                                                                                                                                                                                                                                                                                                | systemd restarts it; a human sees it in `status`/journald |
| API structured logs           | JSON to stdout → journald, correlation id and no IP; 14-day/512M cap                                                                                                                                                                                                                                                                                                                                                          | greppable by correlation id, bounded on disk              |
| Proxy + Postgres logs         | 14-day rotated files                                                                                                                                                                                                                                                                                                                                                                                                          | incident triage, bounded                                  |
| Nightly jobs ran              | `systemctl list-timers kajianq-cron.timer kajianq-backup.timer`; `journalctl -u kajianq-cron` / `-u kajianq-backup`; a deploy runs the cron oneshot once                                                                                                                                                                                                                                                                      | a missed or failed run is visible **if someone looks**    |
| Backups exist                 | `restic snapshots` in the repository                                                                                                                                                                                                                                                                                                                                                                                          | on demand                                                 |
| Post-cutover health (staging) | The `Staging` workflow's `post-deploy-checks` job: Golden Set smoke, then ZAP baseline (`fail_action: true`) + Schemathesis fuzz, on every main merge outside `paths-ignore` — the scans run only after the smoke passes (deliberate — a deployment that fails its own smoke is not worth scanning; #360, the trade recorded in the "A red Golden Set smoke deliberately stops …" comment in `.github/workflows/staging.yml`) | a push/merge outside `paths-ignore`, not a clock          |
| TLS expiry                    | certbot's renewal                                                                                                                                                                                                                                                                                                                                                                                                             | certbot only; no alert if renewal stops                   |

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

| I want to…                            | Do this                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy the current `main` to staging  | push a commit outside `paths-ignore` to `main` (or dispatch the `Staging` workflow)                                                                                                                                                                                                                     |
| Deploy a specific ref manually        | dispatch `Deploy to VPS` with `environment: staging`, then again with `prod` (approval)                                                                                                                                                                                                                 |
| Deploy from the deploying machine     | `provision/vps/deploy/deploy.sh --env /etc/kajianq/deploy.env`                                                                                                                                                                                                                                          |
| See what a deploy would do            | `provision/vps/deploy/deploy.sh --dry-run`                                                                                                                                                                                                                                                              |
| Apply/refresh hardening               | `sudo provision/vps/apply.sh --env /etc/kajianq/proxy.env` (idempotent)                                                                                                                                                                                                                                 |
| Change the public hostname            | §1.6 — certbot, `proxy.env`, `ALLOWED_ORIGINS`, `apply.sh`, then `VPS_PUBLIC_URL` in both scopes                                                                                                                                                                                                        |
| Change the environment label          | §1.7 — a fresh rebuild already reads `"env":"staging"`; for a box still reading `production`, `sed` `APP_ENV` in `/etc/kajianq/api.env` as root, restart the unit, then check `/v1/health` (cosmetic: log labels + health JSON only)                                                                    |
| Check migrations                      | `DATABASE_URL=… bun run db:status:all` (§2.3)                                                                                                                                                                                                                                                           |
| Take a snapshot                       | `DATABASE_URL=… bun run db:snapshot create <lowercase-label>` with the posture flag (§2.4)                                                                                                                                                                                                              |
| Verify a snapshot                     | `bun run db:snapshot verify <label>`                                                                                                                                                                                                                                                                    |
| Take a backup now                     | `sudo sh -c '. /etc/kajianq/backup.env && bun provision/vps/backup/kajianq-backup.mjs --label <label>'`                                                                                                                                                                                                 |
| List backups                          | `sudo sh -c '. /etc/kajianq/backup.env && restic snapshots'`                                                                                                                                                                                                                                            |
| Drill a restore                       | §2.6, with the inherited `RESTIC_*`/`PG*` stripped                                                                                                                                                                                                                                                      |
| Restore for real                      | `kajianq-restore.mjs --label … --target-url <scratch>` (§2.7)                                                                                                                                                                                                                                           |
| Reach the DB from elsewhere           | ssh tunnel (§2.8), port 15433 to match the CI convention                                                                                                                                                                                                                                                |
| Load the corpus (ingest a collection) | [`docs/CORPUS-INGEST.md`](./CORPUS-INGEST.md) — the operator runbook: preconditions, the snapshot gate, one pass per collection                                                                                                                                                                         |
| Read the API logs                     | `sudo journalctl -u kajianq-api -f` (non-root users need `systemd-journal` group membership)                                                                                                                                                                                                            |
| Check the provider posture            | the boot line: `sudo journalctl -u kajianq-api -n 50` → `providers.posture` — `reviewer` (`wired`/`not_wired`; `not_wired` ⇒ every chat call answers 503 and `missingKeys` names the key to bind), `preGate` (`active`/`not_wired`), `missingKeys`, `ineligibleKeys`; env var names only, never a value |
| Check the schedules                   | `systemctl list-timers kajianq-cron.timer kajianq-backup.timer`                                                                                                                                                                                                                                         |

## Related

- [`adr/0044-vps-serving-path-cutover.md`](../adr/0044-vps-serving-path-cutover.md) — the serving path, the deployer's home, the single-shot cutover
- [`adr/0043-netcup-vps-hosting-gdpr-posture.md`](../adr/0043-netcup-vps-hosting-gdpr-posture.md) — the register, retention values, backups
- [`adr/0038-corpus-snapshot-durability-guardrail.md`](../adr/0038-corpus-snapshot-durability-guardrail.md) — the snapshot discipline
- [`docs/VPS-SETUP.md`](./VPS-SETUP.md) — the fork-and-run path: standing up an instance of your own from a bare VPS, including the hardening steps and the restore test (this file is the manual for the project's own box)
- [`docs/VPS-CUTOVER-RECORD.md`](./VPS-CUTOVER-RECORD.md) — the executed migration, its evidence, and the #181 acceptance-criteria walk-through
- [`docs/GDPR-ARTICLE-30-RECORD.md`](./GDPR-ARTICLE-30-RECORD.md) — retention values and TOMs this box implements
