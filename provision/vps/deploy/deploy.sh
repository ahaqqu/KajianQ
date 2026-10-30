#!/usr/bin/env bash
# provision/vps/deploy/deploy.sh — the VPS deploy path: preflight → build →
# upload → helper swap → cron proof → smoke → doctor (ADR-0044).
#
# This is the deployer's own home, deliberately OUTSIDE apps/ (issue #181's
# deployer-separation criterion): app code holds no hosting or deploy logic,
# host configuration lives in ahaqqu/vps, CI gates stay in .github/workflows/,
# and the deploy path lives here with the workflow that calls it. A single
# decision, recorded in ADR-0044 decision 3.
#
# Two read-only preflights run before anything is built or uploaded, because a
# red after the helper swap would leave a new tree live and the smoke and doctor
# skipped — an unverified deployment already serving:
#
#   1. the database is current. `bun run db:status:all:json` reads the shared
#      schema_migrations ledger (engine, domain and product sets), and any
#      pending migration refuses the deploy before the build, naming the files
#      and the exact `db:up:*` command. Migrations are an operator action, and
#      the smoke cannot see a stale schema, so a deploy that did not check it
#      could report healthy on a box where every admin route already 503s.
#   2. the backup job's durable record proves it ran as installed.
#
# Neither changes installed state, so a red costs an ssh round trip and nothing
# else. The migration check is read-only and also runs under --dry-run: a dry
# run that skipped it would describe a deploy the real path refuses.
#
# A deploy never applies a migration. It refuses while one is pending, so the
# operator order MIGRATE, THEN RESTART (docs/VPS-OPERATIONS.md §2.3) is enforced
# rather than merely documented: a release that ships an `apps/api` migration
# requires `bun run db:up:api` (or the set the message names) before this script
# runs. Apply-first is safe because the migrations are additive, so the previous
# build ignores the new table. Until that table exists the new build answers the
# session probe as signed out (200 `{authenticated:false}`) and accepts a login —
# neither reads the denylist — while every admin read and a logout carrying a
# live token fail closed with 503. The smoke below cannot see that state (health,
# the anonymous mint and the chat page never touch the admin surface), which is
# exactly why the preflight has to.
#
# Usage:
#   provision/vps/deploy/deploy.sh --env /etc/kajianq/deploy.env
#   provision/vps/deploy/deploy.sh --env <path> [--dry-run] [--no-smoke] [--skip-migration-check]
#
# Wherever the box is named, it comes from an env file that is NOT in the
# repository (the repo is public — no real hostname may enter its history):
#
#   KAJIANQ_DEPLOY_HOST   the server (or a ~/.ssh/config alias)
#   KAJIANQ_DEPLOY_USER   the deploy identity (kajianq-deploy — a fixed account,
#                         see the note below)
#   KAJIANQ_DEPLOY_ROOT   optional operator label for the tree the helper's
#                         root-only contract swaps. The contract is
#                         authoritative; this value is logged for comparison and
#                         never gated, because nothing the deploy identity can
#                         read proves it matches the contract.
#   KAJIANQ_PUBLIC_URL    the public base URL the smoke test hits
#
# and from the environment (the same env file on the operator path,
# secrets.STAGING_DATABASE_URL on the workflow path):
#
#   DATABASE_URL          the deployment database through the tunnel port the
#                         migration preflight opens and closes (docs/
#                         VPS-OPERATIONS.md §2.3). It never reaches argv and is
#                         never printed; an empty one refuses the deploy unless
#                         --skip-migration-check is passed explicitly.
#
# The deploy identity is a dedicated unprivileged account, not a human admin
# login: its authorization is the shared `vps-deploy kajianq` helper (deploy,
# rollback and the four bounded service verbs), the cron proof
# (`systemctl start kajianq-cron.service`) and two read-only diagnostics for the
# §5 doctor gate. The contract and the grant live in the host-configuration
# repository (ahaqqu/vps under kajianq/), which its root applier installs; this
# repository carries no copy to keep in sync. The identity uploads the artifact
# into /srv/vps-incoming as a member of the upload group; the helper, not the
# identity, writes the deployed tree. The name is fixed rather than configurable
# so the account, the grant, and CI's VPS_USER cannot drift apart silently.
#
# The helper's app name and incoming path are fixed by that contract:
# /srv/vps-incoming/kajianq.tar.gz, uploaded by kajianq-deploy and swapped by
# `vps-deploy kajianq`. The contract's target, ownership, size caps and health
# URL are root-only and not readable by the deploy identity, so this script
# agrees on the app name and the incoming path and leaves the rest to the
# helper.
#
# The deploy is NOT zero-downtime and does not try to be (ADR-0044 decision 2):
# there are no live users, so the helper's single-shot tree swap + restart is
# the recorded choice, not an omission. A reverse-proxy cache or a second port
# would be choreography with no beneficiary.
#
# The deploy ends with a shared-box doctor gate (§5): the box hosts other apps
# (the manifest lives in the private ahaqqu/homepage repo), so a deploy that
# leaves nginx or a neighbour unhealthy turns THIS build red instead of
# surfacing later as a mystery on the other side. The sweep is one copy on the
# box, run over ssh — no GitHub credential, no temp file on the box — and needs
# the two read-only diagnostics in the grant (nginx -t, certbot certificates); until the box has converged to that grant, the sweep's nginx
# check degrades to a warning rather than failing every deploy.
#
# Exit non-zero on the first failure: a half-shipped tree that reports success
# is worse than a failed deploy, because the operator would stop looking.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="/etc/kajianq/deploy.env"
DRY_RUN=0
RUN_SMOKE=1
SKIP_MIGRATION_CHECK=0

log() { printf '%s\n' "deploy: $*"; }

run() {
    if [ "${DRY_RUN}" -eq 1 ]; then
        log "would: $*"
    else
        "$@"
    fi
}

while [ $# -gt 0 ]; do
    case "$1" in
        --env)
            ENV_FILE="${2:?--env needs a path}"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        --no-smoke)
            RUN_SMOKE=0
            shift
            ;;
        --skip-migration-check)
            # The only way past the migration preflight, and deliberately a
            # command-line flag: a skipped check is visible in the invocation
            # that ran, never an environment variable CI could inherit.
            SKIP_MIGRATION_CHECK=1
            shift
            ;;
        *)
            echo "deploy: unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

if [ ! -f "${ENV_FILE}" ]; then
    echo "deploy: ${ENV_FILE} not found. Copy provision/vps/deploy/deploy.env.example" >&2
    echo "deploy: there, fill it in, and chmod 600 it." >&2
    exit 1
fi

# The env file is sourced (it may carry an ssh key path), so it must not be
# written by anyone but its owner. Fail closed rather than trusting a chmod.
# `8#` is load-bearing: `stat -c %a` prints an octal-looking string without a
# leading 0 (600, not 0600), and bash's `0#` form rejects a leading digit 6
# with "invalid number" — inside `[ ]` that error is a false condition, which
# is exactly the fail-open this check exists to prevent. Parsing explicitly in
# base 8 accepts both printed forms and rejects 644.
env_mode="$(stat -c '%a' "${ENV_FILE}")"
if [ "$((8#${env_mode} & 077))" -ne 0 ]; then
    echo "deploy: ${ENV_FILE} is mode ${env_mode} — must be 0600 or tighter" >&2
    exit 1
fi

# shellcheck source=/dev/null
. "${ENV_FILE}"

# Only the two values the script itself uses are required. The tree is an
# optional operator label: the helper's root-only contract decides the target,
# and nothing the deploy identity can read proves the label matches, so gating
# on it would promise a check that does not exist.
for var in KAJIANQ_DEPLOY_HOST KAJIANQ_DEPLOY_USER; do
    # shellcheck disable=SC2154
    if [ -z "${!var:-}" ]; then
        echo "deploy: ${var} is empty in ${ENV_FILE}" >&2
        exit 1
    fi
done

DEPLOY_ROOT="${KAJIANQ_DEPLOY_ROOT:-}"
PUBLIC_URL="${KAJIANQ_PUBLIC_URL:-}"
SSH_TARGET="${KAJIANQ_DEPLOY_USER}@${KAJIANQ_DEPLOY_HOST}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/kajianq-deploy-XXXXXX")"
trap 'rm -rf "${STAGE}"' EXIT

# --- 0. preflight: the shared migration ledger is current --------------------
# The deploy ships code, never schema: migrations are an operator action (§2.3),
# so a database behind this checkout must stop the deploy HERE — before the
# build, the ship and the restart. The check reads the shared ledger through
# `bun run db:status:all:json` (engine, domain and product sets share one
# schema_migrations table), opens and closes its own ssh tunnel because the
# database is loopback-only on the box, and refuses on pending migrations, a
# missing DATABASE_URL, or a status command that cannot run. It is read-only, so
# a red costs a round trip and leaves the box untouched; being read-only is also
# why it runs under --dry-run (see the header).
#
# The check is a separate file so the tests execute the file that runs: the
# tunnel lifecycle (including the exit trap), the parsing, and every refusal
# live in provision/vps/deploy/migration-check.sh.
log "preflight: the migration ledger (bun run db:status:all:json)"
if [ "${SKIP_MIGRATION_CHECK}" -eq 1 ]; then
    DATABASE_URL="${DATABASE_URL:-}" KAJIANQ_DB_TUNNEL_TARGET="${SSH_TARGET}" \
        bash "${REPO_DIR}/provision/vps/deploy/migration-check.sh" --skip-migration-check
else
    DATABASE_URL="${DATABASE_URL:-}" KAJIANQ_DB_TUNNEL_TARGET="${SSH_TARGET}" \
        bash "${REPO_DIR}/provision/vps/deploy/migration-check.sh"
fi

# --- 1. preflight: the backup unit's provenance -----------------------------
# The assertion is "kajianq-backup.service has a completed backup recorded since
# its current definition was installed": the job's durable provenance record says
# the last completed run exited 0 AND completed after that install. Its logic, and
# why the record rather than systemd's reboot-cleared runtime fields is the
# evidence, live in provision/vps/deploy/backup-provenance.sh — piped over ssh,
# so the file the tests execute against fixtures is the file that runs on the box.
#
# It runs BEFORE the build and before the first mutation because it reads only
# state that already exists on the box: a red here leaves the box on its previous
# revision, where the same red later in the path would leave the new tree live,
# the API restarted, and the smoke and the doctor below skipped — an unverified
# deployment already serving.
log "preflight: the backup unit's provenance"
run ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" bash -s \
    <"${REPO_DIR}/provision/vps/deploy/backup-provenance.sh"

# --- 2. build ---------------------------------------------------------------
# Three artifacts, all bundled for Bun so the box needs no node_modules:
#   api/index.js   the serving entry  (apps/api/src/boot.ts)
#   api/cleanup.js the cron entry     (apps/api/src/cleanup.ts)
#   api/backup.js  the backup job     (provision/vps/backup/kajianq-backup.mjs)
# `--target=bun` is what makes `pg` a plain dependency of the bundle rather
# than a runtime resolve against a tree the box does not have.
#
# The backup job is bundled for a different reason than the other two: it is the
# only unit that used to execute code out of the repository CHECKOUT
# (`/srv/kajianq-src`), which the deploy never updated — so production ran
# whatever revision happened to be checked out there, and a re-render could wire
# the unit to stale code (#181). Shipping it beside the API entries puts every
# production-executed file under the deploy's control and removes the
# placeholder that had to be substituted into ExecStart.
log "building web bundle + API entries"
run bun --version >/dev/null
# `bun run` in an explicit subshell cd: `--cwd` is a runtime flag, not a
# documented `bun run` option, and a deploy step must not lean on undocumented
# flag forwarding to work on the box.
run sh -c "cd '$REPO_DIR' && bun run build:web"
run bun build "${REPO_DIR}/apps/api/src/boot.ts" --target=bun \
    --outfile "${STAGE}/api/index.js"
run bun build "${REPO_DIR}/apps/api/src/cleanup.ts" --target=bun \
    --outfile "${STAGE}/api/cleanup.js"
# `lib.mjs` is inlined by the bundler, so the deployed artifact is
# self-contained and location-independent (it does not need the checkout).
run bun build "${REPO_DIR}/provision/vps/backup/kajianq-backup.mjs" --target=bun \
    --outfile "${STAGE}/api/backup.js"

if [ "${DRY_RUN}" -eq 0 ]; then
    # `index.html` is the proof the web build actually produced an SPA: a
    # deploy that ships an empty directory would otherwise serve the API's own
    # 503 and look like an app bug.
    if [ ! -f "${REPO_DIR}/apps/web/dist/index.html" ]; then
        echo "deploy: apps/web/dist/index.html is missing — the web build produced no SPA" >&2
        exit 1
    fi
    mkdir -p "${STAGE}/web"
    cp -r "${REPO_DIR}/apps/web/dist/." "${STAGE}/web/"
fi

# The helper only strips group/other write and applies the contract's mode to
# the tree root; it does not restore readability on the members. Normalize the
# staged tree so a build under a stricter umask (027) cannot ship a bundle the
# `kajianq` service account or nginx cannot read — the guarantee the removed
# `rsync --chmod=D755,F644` provided.
run find "${STAGE}/api" "${STAGE}/web" -type d -exec chmod 0755 {} +
run find "${STAGE}/api" "${STAGE}/web" -type f -exec chmod 0644 {} +

# One artifact at the archive root, so the helper's tar-table check sees exactly
# the tree it swaps — api/index.js, api/cleanup.js, api/backup.js and web/ —
# and nothing else. The archive is written beside those trees and the tar lists
# only `api` and `web`, so it cannot include itself.
run tar -czf "${STAGE}/kajianq.tar.gz" -C "${STAGE}" api web
# The helper refuses an artifact writable by group or other; pin the mode rather
# than depend on the operator's umask.
run chmod 0644 "${STAGE}/kajianq.tar.gz"

# --- 3. upload --------------------------------------------------------------
# One artifact into the upload directory, never into the live tree: the helper
# verifies it (owner, size caps, relative regular entries), unpacks it root-owned
# and swaps the whole tree. A half-written file in the target is the failure the
# swap exists to prevent. `-a` preserves the 0644 mode the helper requires; the
# remote name is fixed by the contract.
log "uploading the artifact for ${SSH_TARGET} to /srv/vps-incoming/kajianq.tar.gz"
if [ -n "${DEPLOY_ROOT}" ]; then
    log "operator-declared target: ${DEPLOY_ROOT} (the helper's contract is authoritative)"
fi
run rsync -a --partial -e "ssh ${SSH_OPTS[*]}" \
    "${STAGE}/kajianq.tar.gz" "${SSH_TARGET}:/srv/vps-incoming/kajianq.tar.gz"

# --- 4. swap, restart and health-check through the helper --------------------
# The helper is the only writer of the live tree: it verifies the artifact
# against the root-only contract (/etc/vps/deploy/kajianq.conf), unpacks it into
# a root-owned staging tree, moves the current target aside, swaps the new tree
# in, restarts kajianq-api.service and health-checks /v1/health, restoring the
# previous tree on failure. No raw restart or is-active probe here: the helper
# owns the command, its wait and its rollback.
#
# Root grant: the deploy identity may run `vps-deploy kajianq` only through the
# grant installed from ahaqqu/vps (kajianq/sudoers/kajianq-deploy) —
# never a raw systemctl restart. Until that grant is installed the helper call
# fails as "a password is required", which is why the vps contract and grant are
# a prerequisite of this path, not an optional follow-up.
log "asking vps-deploy kajianq to swap the tree its contract names"
run ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" 'sudo -n /usr/local/sbin/vps-deploy kajianq'

# Prove the cron entry still executes end to end (its failure mode — a rotated
# env var, a missing key — is otherwise invisible until 03:17). The helper never
# touches the cron unit; the grant carries the start command.
#
# Absolute binary path: sudoers matches the command string and argv exactly, so
# a bare `systemctl` resolved through PATH would not match the grant — and
# widening it with a wildcard is the privilege-escalation footgun this scoping
# exists to avoid.
SYSTEMCTL=/usr/bin/systemctl
log "running the reclamation once (proves the cron entry executes)"
run ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "sudo ${SYSTEMCTL} start kajianq-cron.service"

# The backup unit is deliberately NOT run here (it is root-only and would
# double the daily dump), so its health is read from its own run record — in the
# preflight above, not here: nothing below changes what that record says.

# --- 5. smoke ---------------------------------------------------------------
# The `ship` skill's pre-prod validation: a health check and an anonymous
# session mint against the PUBLIC URL, through the real proxy and TLS. Not
# against the loopback port — that would skip the proxy, which is where a TLS,
# upstream, or header regression actually shows up.
if [ "${RUN_SMOKE}" -eq 1 ]; then
    if [ -z "${PUBLIC_URL}" ]; then
        echo "deploy: KAJIANQ_PUBLIC_URL is empty — cannot smoke (use --no-smoke to skip)" >&2
        exit 1
    fi
    log "smoke: ${PUBLIC_URL}/v1/health"
    run curl -sSf --max-time 30 "${PUBLIC_URL}/v1/health" >/dev/null
    log "smoke: ${PUBLIC_URL}/v1/auth/anonymous"
    # POST /v1/auth/anonymous must mint a session: it is the one route that
    # touches the store without an LLM, so a green mint proves the proxy, the
    # process, and the database are wired — the failure this smoke exists to
    # catch.
    run curl -sSf --max-time 30 -X POST "${PUBLIC_URL}/v1/auth/anonymous" |
        grep -q '"token"'
    log "smoke: ${PUBLIC_URL}/chat (the SPA through the disk-asset path)"
    # An extensionless client route must come back as HTML: the e2e suite
    # caught exactly this class of bug (extensionless paths served as
    # application/octet-stream, so the browser downloaded the page), and this
    # is the one check that pins the shipped web build on the box — a missing
    # KAJIANQ_WEB_ROOT or a regressed content-type would 503/download here
    # while /v1/health stays green.
    run curl -sSf --max-time 30 -H 'accept: text/html' "${PUBLIC_URL}/chat" |
        grep -qi '<!doctype html'
fi

# --- 6. doctor (the shared-box gate) ----------------------------------------
# The box is shared (manifest: the private ahaqqu/homepage repo): a kajianq
# change that invalidates nginx or starves a neighbour must turn this deploy
# red, not surface later as a mystery on the other app. The sweep is ONE COPY
# ON THE BOX — homepage (the box's owner) updates /srv/vps-ops/doctor.sh on
# every one of its deploys, and every app's deploy runs that same file: no
# vendored duplicate to drift, nothing fetched, no credential. It checks
# nginx -t, sites-enabled hygiene, failed units, every app's listeners and
# units, cert expiry. Runs as the deploy identity, which may do so because
# the grant carries the two read-only diagnostics it needs.
# Until homepage has deployed once since the ops-dir bootstrap the file may
# be absent — a warning, not a failure. Until the box has converged to the
# grant, the sweep's nginx check degrades to a warning instead of
# failing every deploy. Blocking on purpose: a deploy that cannot prove the
# box healthy has not deployed.
log "running the shared-box doctor (cross-app gate)"
run ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" 'if [ -x /srv/vps-ops/doctor.sh ]; then bash /srv/vps-ops/doctor.sh; else echo "deploy: ⚠ /srv/vps-ops/doctor.sh not present yet — has homepage deployed since the ops-dir bootstrap?" >&2; fi'

log "done. deployed and smoke-verified."
