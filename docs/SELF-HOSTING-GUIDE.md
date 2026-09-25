# Self-hosting KajianQ on your own VPS

You have a fresh Debian VPS, no domain necessarily, and you want KajianQ
serving. This guide takes you from a bare box to a green deploy, in the order
the steps actually have to happen. It is written to be followed literally: every
command is one that has been run, and where a step is easy to get subtly wrong
the guide says why.

This is the **fork-and-run** path. The other documents in this repo record how
_the project's own_ box was set up and how it is operated day to day; this one
exists because the repository is open source and the deploy path should be
reproducible by anyone, not only by the person who built it.

| If you want…                                                            | Read                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| To stand up your own instance (this guide)                              | **this file**                                                 |
| The reasoning behind the architecture                                   | [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)                   |
| How the project's own box is operated (deploy, Postgres, restore)       | [`docs/VPS-OPERATIONS.md`](./VPS-OPERATIONS.md)               |
| The hardening posture, step by step                                     | [`docs/VPS-HARDENING-RUNBOOK.md`](./VPS-HARDENING-RUNBOOK.md) |
| The record of the project's own cutover (evidence + the #181 checklist) | [`docs/VPS-CUTOVER-RECORD.md`](./VPS-CUTOVER-RECORD.md)       |

## What you are building

One host runs everything:

```
Internet
   │
   ▼
nginx  :443 (TLS)  ──static──▶  /srv/kajianq/web   (the React PWA build)
   │
   └──/v1/*, /openapi.json, /docs──▶  127.0.0.1:8787  kajianq-api.service
                                       (Bun)

systemd timers:
  kajianq-cron.timer    03:17 nightly   anonymous-session reclamation
  kajianq-backup.timer  03:15 nightly   encrypted restic backup

PostgreSQL + pgvector   127.0.0.1:5432 only
```

The deploy path is CI-owned: a push to `main` (or a manual dispatch) builds the
web bundle and three Bun bundles, ships them over `rsync`, restarts the API,
runs the reclamation once, asserts the backup unit is healthy, and smokes the
public URL through the proxy and TLS. The box itself runs no build tooling and
needs no `node_modules`.

**Cost note, stated plainly.** The serving path calls paid LLM APIs. Price is
weighed in every model decision and each query's cost is recorded on its trace,
but a live instance costs money per question. Ingestion and the Golden Set smoke
also spend. Budget for it before you start, and read [§9](#9-what-it-costs-and-what-you-need-to-buy)
before provisioning keys.

## Before you start

You need:

- **A VPS you are root on**, with a public IPv4. This guide assumes Debian 13
  (trixie); Debian/Ubuntu in general works. 2 GB RAM is the practical floor for
  Postgres + the API + a build-free runtime; 1 GB will swap.
- **Disk.** Size for the corpus, not for the code. The full v1 corpus is
  estimated at ~700,000 chunk rows, and with both 1536-dim vector columns and
  their HNSW indexes that is **~17–18 GiB** of Postgres data
  ([`adr/0020-neon-dual-vector-sizing.md`](../adr/0020-neon-dual-vector-sizing.md)
  holds the arithmetic). Add your restic backups on top if you keep them on the
  same disk, plus a little headroom for WAL and log segments — a 40 GB disk is
  comfortable, 20 GB is tight once backups accumulate, and a small box will fill
  during ingestion rather than during serving. If you ingest only the Quran to
  start, a fraction of that is fine; the figure to plan against is the full
  corpus.
- **A hostname.** A real domain is ideal. If you do not have one,
  `<dotted-IP>.sslip.io` (for example `203-0-113-10.sslip.io`) is a wildcard DNS
  name that resolves to that IP for anyone, free — and Let's Encrypt issues real
  certificates for it. This is what the project's own box uses. One caveat:
  sslip.io names share Let's Encrypt's rate-limit pool, so occasional "too many
  certificates" failures are transient; retry later.
- **API keys** for the providers you intend to run. See
  [§9](#9-what-it-costs-and-what-you-need-to-buy) — two of them are hard
  preconditions of the chat path, not optional extras.
- **A GitHub repository** you control, because the deploy is CI-driven. You can
  fork this one or push a copy; either way you are setting your own repository
  variables and secrets, never reusing anyone else's.
- **~30–45 minutes.** The slow parts are package installation and the first
  certificate issuance.

**Two rules that are not negotiable, because the repository is public:**

- Never commit a real hostname, IP address, certificate path, or credential.
  Every one of them lives in a root-owned env file on the box
  (`/etc/kajianq/*.env`, mode 0600) or in GitHub's variable/secret store.
- Never put personal data through a provider's free tier. The engine enforces
  this per call for any request that declares `PromptData.personalData`, but the
  rule starts with which keys you provision — see [§9](#9-what-it-costs-and-what-you-need-to-buy).

## The order, and why it is this order

The steps below are in an order you cannot rearrange. The reason is that each
one is a precondition of the next, and the failures when you skip ahead are
confusing rather than obvious:

1. **Box baseline** — you need a non-root login and a firewall before anything
   else, and you need to prove that login works from a _second_ terminal before
   you disable password auth.
2. **Runtime packages** — `apply.sh` installs configuration but assumes nginx,
   Postgres, restic, and **Bun at `/usr/bin/bun`** already exist. Bun's location
   is load-bearing: the systemd units run with `ProtectHome=yes`, so a Bun under
   `/home` is invisible to them and `ExecStart` fails with "no such file or
   directory". Install it system-wide, not via the `~/.bun` installer.
3. **Database role and database** — `apply.sh` installs the Postgres _posture_
   but does not create your role or database. Create them before the first
   deploy, or the API starts and immediately fails to connect.
4. **TLS certificate** — the deploy smoke hits `https://`, so the certificate
   must exist before the first deploy, not after.
5. **The checkout on the box** — `apply.sh` runs _from a checkout_, and so does
   the on-host restore drill. How the repo gets there is your choice (git clone,
   `git bundle`, rsync); the box needs the working tree, not a build.
6. **Env files** — `proxy.env` on the box and `deploy.env` on whatever machine
   you deploy from. Both scripts refuse to source a file with any group or other
   permission bit, so `chmod 600` is enforced, not documented.
7. **`apply.sh`** — places every config from `provision/vps/`, creates both
   accounts, installs the sudo grant behind `visudo -cf`, enables the units.
8. **Build and deploy** — either dispatch the workflow, or run `deploy.sh`
   directly from your machine.
9. **Prove it** — the deploy's own gates, plus the restore drill.

The single most common way to end up with a half-working box is to run the
deploy before step 2. If the deploy ships and then the API dies instantly, check
`/usr/bin/bun` first.

---

## 1. Box baseline

Everything in this section runs as root over SSH, except where it says
"from your laptop".

```bash
ssh root@<your-host>

cat /etc/os-release              # note the release; Debian/Ubuntu both work
apt update && apt full-upgrade -y
apt install -y ufw unattended-upgrades curl git sudo unzip
```

### Create your admin user

```bash
adduser <admin>
usermod -aG sudo <admin>
```

From your laptop, copy your **public** key up (generate one with
`ssh-keygen -t ed25519` if you have none):

```bash
ssh-copy-id <admin>@<your-host>
ssh <admin>@<your-host>          # must log in WITHOUT asking for <admin>'s password
```

### Lock down SSH

Edit `/etc/ssh/sshd_config` and set:

```
PermitRootLogin no
PasswordAuthentication no
```

```bash
sudo systemctl restart ssh
```

**Verify from a second terminal that `ssh <admin>@<your-host>` still works
before you close the session you are in.** The open session is your safety rope:
if the sshd edit was wrong, it is the only way back in.

### Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose        # expect exactly 22, 80, 443 (v4 and v6)
```

---

## 2. Runtime packages

```bash
sudo apt-get update
sudo apt-get install -y nginx postgresql postgresql-contrib postgresql-client \
                        restic certbot python3-certbot-nginx
```

Then the pgvector package for **your** Postgres major — Debian 13 ships no
`pgvector` meta-package, so there is no single name that works everywhere. The
engine's first migration runs `CREATE EXTENSION IF NOT EXISTS vector`, so the
extension must be available before migrations run:

```bash
# Postgres 17 (Debian 13's default): postgresql-17-pgvector
# Postgres 18: postgresql-18-pgvector
sudo apt-get install -y "postgresql-$(ls /etc/postgresql | head -1)-pgvector"

sudo -u postgres psql -Atc "SELECT name FROM pg_available_extensions WHERE name='vector'"
# expect: vector
```

Confirm the versions landed, because the log-rotation stanzas assume Debian's
paths:

```bash
nginx -v
psql --version
restic version
```

### Install Bun at `/usr/bin/bun`

This is the step that is easiest to get wrong, and the failure it causes is
obscure. The `~/.bun` installer puts Bun under a home directory — and every unit
here runs with `ProtectHome=yes`, which hides `/home` from the process. The unit
would then fail with "no such file or directory" for a binary that plainly
exists. Install it system-wide instead:

```bash
BUN_VERSION=1.4.0        # match the version this repo pins in .github/workflows/*.yml
curl -fsSL -o /tmp/bun.zip \
  "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"
sudo unzip -o /tmp/bun.zip -d /tmp/bun-extract
sudo install -m 0755 /tmp/bun-extract/bun-linux-x64/bun /usr/bin/bun
rm -rf /tmp/bun.zip /tmp/bun-extract

/usr/bin/bun --version            # expect the version you pinned
```

Match `BUN_VERSION` to the version pinned in `.github/workflows/` (currently
`1.4.0`) so the runtime that builds the bundles and the runtime that executes
them are the same major.

---

## 3. Database role and database

`apply.sh` installs the Postgres posture — the loopback-only listener and the
log policy — but it deliberately does not create a role or a database. Do that
yourself, and keep the password out of your shell history and out of the repo:

```bash
# Generate the password on the box and store it root-only. It never leaves.
sudo install -o root -g root -m 0600 /dev/null /etc/kajianq/db-password
sudo sh -c 'openssl rand -base64 32 | tr -d "/+=" > /etc/kajianq/db-password'
DB_PW="$(sudo cat /etc/kajianq/db-password)"

# Create the role and the database.
sudo -u postgres psql -v pw="$DB_PW" <<'SQL'
CREATE ROLE kajianq LOGIN PASSWORD :'pw';
CREATE DATABASE kajianq OWNER kajianq;
SQL

# Install pgvector into that database.
sudo -u postgres psql -d kajianq -c 'CREATE EXTENSION IF NOT EXISTS vector'

# Prove TCP auth over loopback works with that password.
PGPASSWORD="$DB_PW" psql -h 127.0.0.1 -U kajianq -d kajianq -Atc 'SELECT current_user, current_database()'
# expect: kajianq|kajianq
```

If the last command fails, stop here. The API will not start without it, and a
failure now names the actual problem while a failure at deploy time looks like an
application bug.

---

## 4. TLS certificate

The deploy smoke requests `https://<your-host>`, so the certificate has to exist
first. Issue it against a **running** nginx: certbot's `--nginx` plugin answers
the ACME challenge through a temporary server block, so nginx must be up and
listening on :80.

```bash
sudo systemctl enable --now nginx
curl -I "http://<your-host>/"        # must answer before certbot runs
sudo certbot certonly --nginx -d <your-host>
```

You do not need to write a server block for this: Debian's nginx package ships
a default site listening on :80, which is enough for certbot to work with.
`apply.sh` installs the real server block in §7 and takes over :443 then.

Certbot installs its own renewal timer; you do not need a cron entry. Note where
the files landed — you will need those two paths in `proxy.env`:

```
/etc/letsencrypt/live/<your-host>/fullchain.pem
/etc/letsencrypt/live/<your-host>/privkey.pem
```

---

## 5. Get the checkout onto the box

`apply.sh` runs from a checkout of this repository, and the on-host restore drill
runs from the same tree. Put the working tree somewhere on the box; it does not
need to be built. This guide uses `/srv/kajianq-src`.

```bash
sudo git clone https://github.com/<you>/<your-repo>.git /srv/kajianq-src
```

If the repository is private, clone with a deploy key or transfer a `git bundle`
instead — whatever fits your access model. A private mirror is also fine. The
box needs the **source tree**, and nothing reads it at runtime: every
production-executed file is shipped by the deploy as a bundle under
`/srv/kajianq`, so a stale checkout cannot serve stale code.

---

## 6. Fill in the env files

Four files carry every hostname, certificate path, and credential. Nothing else
does. They are all root-owned and mode 0600, and both scripts **refuse** to
source a file with any group or other bit rather than trusting a documented
`chmod` — a sourced file runs with the operator's privileges.

### On the box: `/etc/kajianq/proxy.env`

Drives the nginx render.

```bash
sudo install -d -o root -g root -m 0700 /etc/kajianq
sudo install -o root -g root -m 0600 /srv/kajianq-src/provision/vps/proxy.env.example \
    /etc/kajianq/proxy.env
sudoedit /etc/kajianq/proxy.env
```

Fill in the four values: your hostname, the two certificate paths from step 4,
and the loopback upstream (`http://127.0.0.1:8787` — leave it as-is unless you
change the API port).

### On the box: `/etc/kajianq/api.env`

The serving process's entire configuration. Copy the example **before** running
`apply.sh`:

```bash
sudo install -o root -g root -m 0600 /srv/kajianq-src/provision/vps/api.env.example \
    /etc/kajianq/api.env
sudoedit /etc/kajianq/api.env
```

Two keys are **hard preconditions of the chat path**, not optional:

- `DEEPSEEK_API_KEY` — the generator/router head and the reviewer
- `GEMINI_PAID_API_KEY` — the embedder head

Without them, a chat question fails its embedder or reviewer stage with a typed
error while `/v1/health` and anonymous session minting stay green — so the
deploy smokes alone will not tell you they are missing. Set them before you
deploy.

Two more values are easy to overlook and both are load-bearing:

- `KAJIANQ_WEB_ROOT=/srv/kajianq/web` — without it, the asset handler's default
  (`./apps/web/dist`) resolves to a path that does not exist on the deployed
  tree, and every SPA route returns 503 while health stays green.
- `ALLOWED_ORIGINS` — set it to your public origin, exactly. This is a strict
  CORS allowlist, not a wildcard.

### On the box: `/etc/kajianq/backup.env`

The backup target. The example defaults to a local path; an **off-box** target
is strongly preferred, because a backup on the same disk as the database does
not survive the disk. Any restic-supported backend works.

```bash
sudo install -o root -g root -m 0600 /srv/kajianq-src/provision/vps/backup/backup.env.example \
    /etc/kajianq/backup.env
sudoedit /etc/kajianq/backup.env
```

Rules that matter:

- The repository holds a **full database dump** — chat content and feedback. It
  must not be a free tier. Use storage you pay for and have a DPA for.
- `RESTIC_PASSWORD_FILE` points at the repository key. Generate it on the box,
  keep it mode 0600 root-owned, keep it **outside this repository**, and copy it
  into your password manager. Losing it makes every backup unrecoverable;
  leaking it makes every backup plaintext.
- The backup script refuses to run if that key file is group- or
  world-readable — a world-readable key silently undoes the encryption it exists
  to provide.

### On your deploying machine: `deploy.env`

This one does **not** go on the box. `deploy.sh` is a deploying-machine script:
it builds locally and reaches the box over SSH.

```bash
install -o root -g root -m 0600 /path/to/checkout/provision/vps/deploy/deploy.env.example \
    /etc/kajianq/deploy.env
sudoedit /etc/kajianq/deploy.env
```

Fill in the host, the deploy user (`kajianq-deploy`), the deployed tree
(`/srv/kajianq`), and the public URL.

---

## 7. Create the backup repository, then apply

The backup repository is a **one-time deliberate step**: it mints the encryption
key, and the key must be recorded by you.

```bash
# Password file, then the repository itself.
sudo install -o root -g root -m 0600 /dev/null /etc/kajianq/restic.pass
sudo sh -c 'openssl rand -base64 48 > /etc/kajianq/restic.pass'
sudo chmod 0600 /etc/kajianq/restic.pass
echo "Copy /etc/kajianq/restic.pass into your password manager NOW."
sudo cat /etc/kajianq/restic.pass

sudo sh -c '. /etc/kajianq/backup.env && restic -r "$RESTIC_REPOSITORY" init'
```

Now apply the configuration. This is idempotent — re-running it is safe and is
the normal way to pick up a config change.

```bash
cd /srv/kajianq-src
sudo provision/vps/apply.sh --env /etc/kajianq/proxy.env
```

`--dry-run` prints every action without writing, which is worth one pass the
first time.

What it does, in order: creates the `kajianq` service account and the
`kajianq-deploy` identity; renders and installs the nginx server block and
reloads nginx; installs both logrotate stanzas and validates them; installs the
journald cap; installs the Postgres posture; installs and **enables** (does not
start) the API and cron units; installs the backup units and enables the timer;
installs the sudo grant for `kajianq-deploy` only after `visudo -cf` parses it.

### Create the deploy identity's key

CI authenticates as `kajianq-deploy`, never as your admin login — otherwise the
workflow would hold an admin credential and the two-command grant would scope
nothing. Generate a key pair **for CI only** (on your deploying machine, not on
the box), then install the public half:

```bash
# On your deploying machine.
ssh-keygen -t ed25519 -f ~/.ssh/kajianq-deploy -C kajianq-vps-deploy-key -N ''

# On the box, as root — or pass the .pub to apply.sh's --deploy-pubkey instead
# and let it do this step.
sudo install -d -o kajianq-deploy -g kajianq-deploy -m 0700 /home/kajianq-deploy/.ssh
sudo sh -c 'cat <your-deploy-pubkey.pub> >> /home/kajianq-deploy/.ssh/authorized_keys'
sudo chown kajianq-deploy:kajianq-deploy /home/kajianq-deploy/.ssh/authorized_keys
sudo chmod 0600 /home/kajianq-deploy/.ssh/authorized_keys
```

Then prove the grant actually authorizes, from your deploying machine. A
sudoers file that parses is not the same thing, and a missing grant fails with a
confusing "a password is required" that names neither the rule nor the command:

```bash
ssh -i ~/.ssh/kajianq-deploy kajianq-deploy@<your-host> \
    'sudo -n systemctl restart kajianq-api.service && systemctl is-active kajianq-api.service'
```

That restart also starts the API for the first time. If it is the very first
deploy, the API will have no bundles shipped yet and will fail to start — that
is expected before §8, and the `sudo -n` succeeding is the part being tested.

### Verify the apply

```bash
systemctl status kajianq-api                    # enabled, inactive until you start it
systemctl list-timers kajianq-backup.timer      # scheduled 03:15 daily
systemctl list-timers kajianq-cron.timer        # scheduled 03:17 daily
sudo nginx -t
sudo -l -U kajianq-deploy                       # exactly two systemctl commands
```

---

## 8. Deploy

### Wire up GitHub first

In your repository, set these variables (**Settings → Secrets and variables →
Actions → Variables**):

| Kind   | Name                      | Value                                             |
| ------ | ------------------------- | ------------------------------------------------- |
| var    | `VPS_HOST`                | your host, or an ssh-config alias                 |
| var    | `VPS_USER`                | `kajianq-deploy`                                  |
| var    | `VPS_PUBLIC_URL`          | `https://<your-host>`                             |
| var    | `VPS_ROOT`                | `/srv/kajianq`                                    |
| secret | `VPS_DEPLOY_SSH_KEY`      | the **private** half of the CI key from step 7    |
| secret | `STAGING_DATABASE_URL`    | `postgres://kajianq:<pw>@127.0.0.1:15433/kajianq` |
| secret | `RATE_BYPASS_PRIVATE_KEY` | see below                                         |

Two notes on those:

- `STAGING_DATABASE_URL` names the **tunnel port** `15433`, not 5432: the
  database is loopback-only, and the workflow opens an SSH tunnel to reach it.
- `RATE_BYPASS_PRIVATE_KEY` signs tokens that exempt the security scanners from
  the per-IP rate limit (metering only, never auth). The matching **public** key
  is committed in `apps/api/src/lib/rate-bypass.ts`. Because that public key is
  part of the repository, **your instance verifies anyone's tokens unless you
  rotate it**: generate your own pair, commit the new public key, and set your
  private key as this secret. Mint one with `bun run rate:bypass` (see
  `adr/0041-rate-limit-scoped-to-api-surface.md`). If you skip the workflow
  entirely, leave this unset — the scanners simply run metered.

Then create an environment named **`prod`** with a required reviewer (yourself)
if you want the approval gate on production deploys, and give it the same
`VPS_*` variables plus its own `VPS_DEPLOY_SSH_KEY` secret. Environment-scoped
values override repository-scoped ones, which is how one repository can hold two
environments.

### Dispatch

From the repository's **Actions** tab, run **Deploy to VPS** with
`environment: staging`. Or from a terminal:

```bash
gh workflow run "Deploy to VPS" --repo <you>/<your-repo> -f environment=staging
gh run watch --repo <you>/<your-repo>
```

Prefer the dispatch over running `deploy.sh` by hand the first time: it
exercises the same path your pushes will, including the deploy key and the
variables you just set.

### Or deploy directly from your machine

```bash
provision/vps/deploy/deploy.sh --env /etc/kajianq/deploy.env
```

Useful flags: `--dry-run` to print without shipping, `--no-smoke` to skip the
public-URL checks (for a box whose DNS or certificate is not ready yet).

### What the deploy proves, and what it does not

The deploy gates on all of these, and fails loudly on any of them:

- the web build produced an SPA (`apps/web/dist/index.html` exists)
- the API restarted and `systemctl is-active` reports active
- the reclamation ran once — so a rotated env var fails the deploy rather than
  surfacing at 03:17
- **the backup unit is healthy**: its last run exited 0 **and** that run is
  newer than the unit file's own install time. That second condition is what
  catches a unit that was installed but never executed — a state no single
  systemd field reports, and one this project has been bitten by
- the public URL answers `/v1/health`, mints an anonymous session, and serves
  `/chat` through the real proxy and TLS

It does **not** prove your provider keys work. As noted in step 6, health and
anonymous minting stay green with a missing reviewer or embedder key. The Golden
Set smoke in the `Staging` workflow is what exercises the real answering path —
run that next.

> **Ordering trap.** `apply.sh` re-installs the backup unit, and GNU `install`
> rewrites the destination even when the content is identical, which bumps the
> unit file's mtime. The deploy's backup gate compares the last run against that
> mtime, so **re-running `apply.sh` invalidates the gate until a backup runs
> again**. Prove it with the service, not the script:
> `sudo systemctl start kajianq-backup.service`. Running
> `kajianq-backup.mjs` directly writes a snapshot but does not update the
> service's `ExecMainStatus`, so it will not satisfy the gate.

---

## 9. What it costs, and what you need to buy

The engine is model-agnostic and the vendor/model selection is configuration, so
you are not locked to any provider. What the default configuration expects:

| Role                 | Default head      | Key                   | Required?                                |
| -------------------- | ----------------- | --------------------- | ---------------------------------------- |
| Embedder             | Gemini embeddings | `GEMINI_PAID_API_KEY` | **Yes** — chat fails without it          |
| Generator + router   | DeepSeek          | `DEEPSEEK_API_KEY`    | **Yes** — chat fails without it          |
| Reviewer             | DeepSeek          | `DEEPSEEK_API_KEY`    | **Yes** — shares the key above           |
| Generator challenger | DashScope         | `DASHSCOPE_API_KEY`   | No                                       |
| Free-tier Gemini     | —                 | `GEMINI_API_KEY`      | No — non-personal calls only (ingestion) |

Prices live in `packages/infra/src/providers/models.json`, per model, in
micro-USD per million tokens, and every query's cost is recorded on its trace.
Model choice per stage comes from configuration; there is no vendor name in any
engine `.ts` file, enforced by the boundary gate.

**The paid-vs-free rule is a hard one.** Chat questions can reveal religious
convictions, which is sensitive data. Personal data never routes through a
provider's free tier: the config marks each vendor row `personalDataAllowed`, and
the engine filters free-tier candidates out of any call that declares
`PromptSpec.personalData` — which every serving call site does, as a required
field. Free tiers are for ingestion and tagging.

**Other things you may want to pay for:** the VPS itself, off-box backup
storage (see step 6), and optionally a domain. Sentry is supported but optional
and off when `SENTRY_DSN` is unset.

### Corpus and licensing

You bring your own corpus. The ingestion CLIs are `bun run ingest:quran` and
`bun run ingest:hadith`, and they need `DATABASE_URL` plus provider keys. Read
[`NOTICES/DATASETS.md`](../NOTICES/DATASETS.md) **before** ingesting anything:
it is the attribution register, and some sources carry real constraints.

Two that deserve your attention up front:

- **Kemenag's Indonesian Quran translation** has no open machine-readable
  license. The project uses it for internal ingestion and embedding only, and
  treats redistribution as gated by a licensing review that has not closed.
- **The Quranic Arabic Corpus morphology is GPL.** It is consumed at build time;
  corrections are kept in a separate layer.

Raw source bytes are archived to object storage (R2 or any S3-compatible store)
and never committed to the repository. If you set no object-storage credentials,
ingestion still runs — archival is skipped, and the run reports
`archiveStored: false`.

If you want the Golden Set smoke to pass meaningfully, you need a corpus
ingested and embedded. An empty database answers nothing, and the smoke's
questions will fail on retrieval rather than on your configuration.

---

## 10. Prove it works

Run the full `Staging` workflow (or push any non-docs commit to `main`). It
deploys and then runs three checks against your live box:

| Check            | What it proves                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Golden Set smoke | Real questions, answered by your deployed API and scored from its persisted traces — refusal, dhaif trap, English, and Indonesian cases |
| ZAP baseline     | No new security warnings on the served surface                                                                                          |
| Schemathesis     | The API survives property-based fuzzing against its own OpenAPI spec                                                                    |

Then run the restore drill on the host. This is the acceptance criterion the
whole backup layer exists to serve — a backup nobody has restored is a hope, not
a backup:

```bash
# Strip the production restic env first. The drill sets its own restic password,
# but RESTIC_PASSWORD_FILE takes precedence over it in restic — run the drill
# from a shell that has sourced backup.env and it encrypts with your production
# key and then fails. This is a known sharp edge.
env -u RESTIC_REPOSITORY -u RESTIC_PASSWORD_FILE -u PGDATABASE_URL \
  bun provision/vps/backup/restore-drill.mjs \
    --admin-url "postgres://postgres@127.0.0.1:5432/postgres"
```

It creates and drops its own scratch databases and touches nothing live. It
asserts the restored target **does** hold erased rows (the negative control —
without it the drill could pass while testing nothing), then that re-applying
the reclamation and the erasure cascade makes the restored target match the live
store.

### Confirm the backup timer actually works

Do not trust `is-active` on the timer. It reports that the **schedule** is
armed, and it stayed green through every failed run this project had. Check the
service's real outcome:

```bash
systemctl show kajianq-backup.service -p ExecMainStatus -p ExecMainExitTimestamp
systemctl cat kajianq-backup.service | grep '^ExecStart'
systemctl list-timers kajianq-backup.timer
```

After the first scheduled fire, `ExecMainStatus=0` and a timestamp newer than
the unit file is what "the backup works" looks like.

---

## 11. Day-to-day operations

**Deploy a change.** Push to `main`. CI builds, ships, restarts, and checks.

**Change configuration.** Edit `/etc/kajianq/api.env` and restart the unit:
`sudo systemctl restart kajianq-api.service`. Config is read once at process
start, so a running process keeps the old values.

**Re-apply box configuration.** Edit `provision/vps/*` in your checkout, pull it
on the box, and re-run `apply.sh`. Remember the ordering trap in §8: this
invalidates the backup gate until a backup runs again, so start the service
afterwards.

**Take a backup now.** `sudo systemctl start kajianq-backup.service`.

**Restore for real.** `kajianq-restore.mjs` refuses a target that names the live
database, by comparing the normalized location rather than the raw string — so
you cannot accidentally restore over production.

**Rotate the database password.** `ALTER ROLE kajianq WITH PASSWORD '…'` via
`sudo -u postgres psql`, then update it in `api.env` **and** `backup.env`, then
restart the API. A rotated password otherwise fails the next chat call and the
next backup.

**There is no instant rollback.** The deploy ships a new tree over the old one.
The rollback is `git revert` on `main` and let the deploy run again. Plan for
that before you need it.

### The retention posture you are running

These values are not cosmetic — they are what a privacy notice and a processing
record would declare, so if you change one, change the document that states it:

| Log                            | Rotation                     | Window |
| ------------------------------ | ---------------------------- | ------ |
| Reverse proxy access + error   | daily, `maxsize 100M`, gzip  | 14 d   |
| Postgres                       | daily, `maxsize 100M`, gzip  | 14 d   |
| API structured logs (journald) | byte + time cap              | 14 d   |
| Postgres backups               | daily, restic `--keep-daily` | 30 d   |

The proxy's access-log format is deliberately minimal: client IP, timestamp,
request line, status, bytes, correlation id, request time — no user-agent, no
referrer, no `$remote_user`. Statement text is never logged by Postgres, because
a chat question is personal data and does not belong in an ops log.

### If you serve the public, the privacy duties are yours

Once your instance takes real users, you are the controller for their data, and
this repository's GDPR documents describe the posture the code implements — not
a posture that transfers to you. In particular:

- Anonymous sessions expire after 30 days of inactivity, and
  `DELETE /v1/auth/me` cascades the whole subtree (sessions, chat, traces,
  feedback). Keep that path working if you change auth.
- The `/about` page renders its privacy notice from a typed register
  (`apps/web/src/lib/privacy-notice*.ts`). **Edit those files to state what is
  true of your instance** — your sub-processors, your retention values, your
  contact. The shipped copy describes the project's own deployment.
- If you are in the EU/UK, or you serve people who are, you likely need a DPA
  with your VPS provider and your LLM providers, and a processing record. The
  project's own are in
  [`docs/GDPR-ARTICLE-30-RECORD.md`](./GDPR-ARTICLE-30-RECORD.md) and
  [`docs/GDPR-DPIA-LITE.md`](./GDPR-DPIA-LITE.md), useful as a structural
  template and not as legal advice.

---

## 12. Moving an existing database to this box

If you are migrating from another host — a managed Postgres, a Neon project, an
older VPS — the order below is what keeps the move verifiable. It is the
vendor-neutral part of the project's own cutover, which moved a live Neon
database onto the box this way.

The principle is one sentence: **snapshot the source, verify the snapshot, ship
that exact archive, then snapshot the target and compare.** Never pipe data
straight from the live source into the target, because then the bytes that
arrived are not the bytes you hashed, and a mismatch has no diagnosis.

```bash
# 1. Snapshot the SOURCE, from a machine that can reach it.
#    db:snapshot operates on whatever DATABASE_URL names, so the source is just
#    a URL — no vendor in its configuration.
export DATABASE_URL="postgres://…/olddb"
export R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=…

# If the archive is going to a storage target whose encryption you cannot
# verify, the CLI refuses unless you acknowledge it explicitly.
KAJIANQ_SNAPSHOT_PLAINTEXT_ACKNOWLEDGED=true bun run db:snapshot create pre-move-<label>
bun run db:snapshot verify pre-move-<label>        # compares against the live source
```

`verify` checks the corpus and schema-identity row counts
(`doc_parents`, `doc_children`, `aligned_pairs`, `schema_migrations`) against the
live source exactly, and reports which ledger tables moved on. If it is red, the
fix is never to re-snapshot without those tables, and a label is never deleted
to reduce exposure.

```bash
# 2. Restore onto the box, from the verified archive.
#    The listener is loopback-only, so this runs ON the box.
sudo install -d -o postgres -g postgres -m 0700 /srv/kajianq/restore
# Download the archive on a machine that has your object-storage credentials,
# then copy it over (the box holds none by design).
pg_restore --clean --if-exists --no-owner --no-privileges \
  -d "postgres://kajianq:<pw>@127.0.0.1:5432/kajianq" \
  /srv/kajianq/restore/olddb-pre-move-<label>.dump

# Apply any migration the archive lacks — its schema_migrations ledger says what
# it already has.
DATABASE_URL="postgres://kajianq:<pw>@127.0.0.1:5432/kajianq" bun run db:status:all
DATABASE_URL="postgres://kajianq:<pw>@127.0.0.1:5432/kajianq" bun run db:up:all
```

```bash
# 3. Snapshot the TARGET and compare. Runs on a machine with storage creds,
#    reaching the box's loopback Postgres through an ssh tunnel.
ssh -N -L 5433:127.0.0.1:5432 kajianq-deploy@<your-host> &
export DATABASE_URL="postgres://kajianq:<pw>@127.0.0.1:5433/kajianq"

# The data is now covered by your provider's terms, so this archive uses the
# ENCRYPTED path — not the plaintext acknowledgement of step 1.
KAJIANQ_SNAPSHOT_ENCRYPTED_AT_REST=true bun run db:snapshot create post-move-<label>
bun run db:snapshot verify post-move-<label>
bun run db:snapshot list          # diff the two manifests' tableCounts
```

The corpus and schema counts for `post-move-…` must equal `pre-move-…`
exactly. Ledger and personal tables may differ only by traffic that happened
between the two steps — quote that drift explicitly rather than absorbing it.
Kill the tunnel when you are done (`jobs` / `kill %1`).

Once the box is serving, the restic backup in §6 takes over as the ongoing
durability layer; the portable snapshot above is the migration artifact, and the
two coexist.

---

## Troubleshooting

**The deploy fails at "Require the deploy access."** A variable or the secret is
missing. The step names which one. Check that `VPS_USER` is `kajianq-deploy` and
that the secret holds the **private** key whose public half is in the box's
`authorized_keys`.

**`Permission denied (publickey)` from the runner.** The key is on the box but
for a different account, or `VPS_USER` names an account that does not authorize
it. Confirm with the `ssh -i` test in step 7.

**`sudo: a password is required` during the deploy.** The sudo grant is missing
or names a different user. `sudo -l -U kajianq-deploy` on the box should list
exactly two `systemctl` commands.

**The API is active then immediately fails.** Check `/usr/bin/bun` exists (step
2), then `journalctl -u kajianq-api.service -n 50`. A missing `api.env` key and
a bad `DATABASE_URL` are the two common causes.

**Every SPA route returns 503 while `/v1/health` is green.**
`KAJIANQ_WEB_ROOT` is unset or wrong in `api.env`. Its default resolves to a
path that does not exist on the deployed tree.

**The deploy says the backup unit "has never run".** Start it once:
`sudo systemctl start kajianq-backup.service`. See the ordering trap in §8.

**The backup fails with `git exited 128`.** You are running the backup from the
repository checkout rather than the deployed bundle. The unit runs
`/srv/kajianq/api/backup.js`, which the deploy ships.

**The restore drill fails with a restic exit 12.** You sourced `backup.env`
first. Strip the variables as shown in §10.

**`Script not found` from the backup unit.** The unit's `ExecStart` should name
`/srv/kajianq/api/backup.js`. If it names a `__KAJIANQ_` token or a path under
the checkout, run `apply.sh` and then deploy — the bundle is shipped by the
deploy, not by `apply.sh`.

**nginx will not start after `apply.sh`.** `apply.sh` renders the server block
from `proxy.env` and refuses to install it with a placeholder still in place, so
a failure here usually means a certificate path that does not exist yet. Re-run
step 4.

---

## Related

- [`docs/VPS-OPERATIONS.md`](./VPS-OPERATIONS.md) — the operator's manual for the
  project's own box: deploy, Postgres, backups, restore, monitoring
- [`docs/VPS-HARDENING-RUNBOOK.md`](./VPS-HARDENING-RUNBOOK.md) — every hardening
  measure, step by step, and why each one exists
- [`docs/VPS-CUTOVER-RECORD.md`](./VPS-CUTOVER-RECORD.md) — the executed cutover,
  the evidence behind the #181 acceptance criteria, and the retained record of
  the box's bare-metal baseline session
- [`adr/0020-neon-dual-vector-sizing.md`](../adr/0020-neon-dual-vector-sizing.md)
  — the corpus storage arithmetic behind the disk guidance in "Before you start"
- [`adr/0043-netcup-vps-hosting-gdpr-posture.md`](../adr/0043-netcup-vps-hosting-gdpr-posture.md)
  — the hosting and privacy posture these configs implement
- [`adr/0044-vps-serving-path-cutover.md`](../adr/0044-vps-serving-path-cutover.md)
  — the serving path, the deploy identity, and the cutover
- [`NOTICES/DATASETS.md`](../NOTICES/DATASETS.md) — corpus attribution and
  licensing duties, before you ingest anything
