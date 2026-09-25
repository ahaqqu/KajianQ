#!/usr/bin/env bash
# provision/vps/apply.sh — place the hardening configs on the VPS and enable the
# services (ADR-0043, issue #180).
#
# Run this ON the netcup VPS, as root, from a checkout of this repository:
#
#   sudo provision/vps/apply.sh --env /etc/kajianq/proxy.env
#
# The script is idempotent: every step either overwrites a file with the
# version from the repo or enables an already-enabled unit. Nothing here touches
# data — it writes configuration, creates the service account and directories,
# and enables units. The backup repository's one-time `restic init` is a
# separate, deliberate step in docs/VPS-SETUP.md, because it mints
# the encryption key and must be recorded by the owner.
#
# Substitutions: every `__KAJIANQ_*` placeholder in the shipped configs is
# replaced from --env. No hostname, certificate path, or origin address is
# committed to the repository, so this file is the only place they appear — and
# it reads them from a root-only env file, not from argv.
#
# Usage:
#   provision/vps/apply.sh [--env <file>] [--dry-run] [--deploy-pubkey <file>]
#
# --deploy-pubkey installs the given public key file into the deploy account's
# authorized_keys. Without it, the key step is left to the operator (the
# setup doc carries the command that moves the deploy keys off the admin
# account); a key is never read from the repository, which is public.
#
# Exit non-zero on the first failure: a half-applied hardening config is worse
# than an unapplied one, because it looks done.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="${REPO_DIR}/provision/vps"
ENV_FILE="/etc/kajianq/proxy.env"
DRY_RUN=0
DEPLOY_PUBKEY=""

# The deploy identity is fixed, not configurable (#181, ADR-0044 deploy-identity
# amendment). Three places must agree on it: this account here, the sudoers
# grant in provision/vps/sudoers/kajianq-deploy, and the CI variable VPS_USER
# that the deploy workflow passes as KAJIANQ_DEPLOY_USER. A configurable name
# would let the grant and the caller disagree, and the deploy would then fail
# with a confusing "password is required" rather than a named mismatch — so
# name drift is a lint failure (tests/scripts/vps-hardening.test.mjs), not a
# silent possibility.
DEPLOY_USER="kajianq-deploy"

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
        --deploy-pubkey)
            DEPLOY_PUBKEY="${2:?--deploy-pubkey needs a path}"
            shift 2
            ;;
        *)
            echo "apply: unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

log() { printf '%s\n' "apply: $*"; }

run() {
    if [ "${DRY_RUN}" -eq 1 ]; then
        log "would: $*"
    else
        "$@"
    fi
}

[ "$(id -u)" -eq 0 ] || {
    echo "apply: must run as root (it writes /etc and enables units)" >&2
    exit 1
}

# --env may be omitted only when every placeholder is already substituted by an
# existing config; requiring it keeps the substitution honest.
if [ ! -f "${ENV_FILE}" ]; then
    echo "apply: ${ENV_FILE} not found. Copy provision/vps/proxy.env.example there," >&2
    echo "apply: fill it in with the real domain, TLS paths and API upstream, chmod 600." >&2
    exit 1
fi

# The env file is executed with root privileges, so it must be root-owned and
# readable only by root before it is sourced: a group/world-writable file
# would let any local user inject commands that run as root on the next apply.
# Fail closed on the first apply rather than trusting the setup doc's chmod.
env_owner="$(stat -c '%U:%G' "${ENV_FILE}")"
env_mode="$(stat -c '%a' "${ENV_FILE}")"
if [ "${env_owner}" != "root:root" ]; then
    echo "apply: ${ENV_FILE} is owned by ${env_owner} — must be root:root before sourcing" >&2
    exit 1
fi
# `8#` is load-bearing: `stat -c %a` prints an octal-looking string without a
# leading 0 (600, not 0600), and bash's `0#` form rejects a leading digit 6
# with "invalid number" — inside `[ ]` that error is a false condition, which
# is exactly the fail-open this check exists to prevent. Parsing explicitly in
# base 8 accepts both printed forms and rejects 644.
if [ "$((8#${env_mode} & 077))" -ne 0 ]; then
    echo "apply: ${ENV_FILE} is mode ${env_mode} — must be 0600 or tighter (no group/other bits)" >&2
    exit 1
fi

# shellcheck source=/dev/null
. "${ENV_FILE}"

for var in KAJIANQ_DOMAIN KAJIANQ_TLS_CERT KAJIANQ_TLS_KEY KAJIANQ_API_UPSTREAM; do
    # shellcheck disable=SC2154
    if [ -z "${!var:-}" ]; then
        echo "apply: ${var} is empty in ${ENV_FILE}" >&2
        exit 1
    fi
done

# --- service account and directories ---------------------------------------
if ! id -u kajianq >/dev/null 2>&1; then
    run useradd --system --home /srv/kajianq --shell /usr/sbin/nologin kajianq
fi

# The deploy identity (#181, ADR-0044 deploy-identity amendment): a real login
# account whose entire purpose is the deploy path, so CI's key is not the
# owner's admin account and the root grant is scoped to it. `system` because it
# runs no interactive session; bash (not nologin) because ssh executes the
# deploy's remote commands through it; no sudo group membership, because
# /etc/sudoers.d/kajianq-deploy is the whole grant.
if ! id -u "${DEPLOY_USER}" >/dev/null 2>&1; then
    run useradd --system --create-home --shell /bin/bash "${DEPLOY_USER}"
fi

# The deployed tree is owned by the deploy identity, not the service account.
# That is what lets `rsync --delete` write it, remove stale content-hashed
# assets, and re-stamp times on unchanged files with no group-write grant: the
# deploy user is the owner, so owner permissions suffice and the 0755 modes stay
# as they are. A migration from the previous arrangement (tree owned by the
# admin login) needs the recursive chown below — `install -d` fixes the
# directories but leaves the existing files behind, and rsync -t then fails with
# "failed to set times" on the first unchanged file, which is precisely the
# failure docs/VPS-OPERATIONS.md §1.5 records from the first deploy attempts.
#
# The API process runs as `kajianq` and only ever READS this tree (nothing in
# apps/api writes to disk), so ownership can move without changing what the
# service can do — it reaches the tree through the 0755 world bits, and it never
# had write access here anyway (the previous ownership was the admin user with
# group `kajianq` and mode 755). The unit's ReadWritePaths stays as it is: the
# path is still the runtime's scratch allowance, and the hardened posture is
# unchanged by who owns the files.
run install -d -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" -m 0755 \
    /srv/kajianq /srv/kajianq/api /srv/kajianq/web
if [ "${DRY_RUN}" -eq 0 ]; then
    chown -R "${DEPLOY_USER}:${DEPLOY_USER}" /srv/kajianq/api /srv/kajianq/web
else
    log "would: chown -R ${DEPLOY_USER}:${DEPLOY_USER} /srv/kajianq/api /srv/kajianq/web"
fi
run install -d -o root -g root -m 0700 /etc/kajianq

# --- the deploy identity's root grant ---------------------------------------
# Installed only after `visudo -cf` parses the candidate: a malformed file in
# sudoers.d can lock sudo out of the box entirely, so the parse gates the
# install rather than following it. The candidate is validated first and moved
# into place after, so a failed parse leaves the previous grant intact.
install_sudoers() {
    local src="${SRC}/sudoers/kajianq-deploy"
    local dst="/etc/sudoers.d/${DEPLOY_USER}"
    local tmp
    tmp="$(mktemp)"
    cat "${src}" >"${tmp}"
    if [ "${DRY_RUN}" -eq 1 ]; then
        log "would: install ${src} -> ${dst} (after visudo -cf)"
        rm -f "${tmp}"
        return 0
    fi
    if ! visudo -cf "${tmp}"; then
        rm -f "${tmp}"
        echo "apply: ${src} failed visudo -cf — not installing ${dst}" >&2
        exit 1
    fi
    # The staged name keeps a dot so sudo ignores it while it exists: sudoers(5)
    # skips files in sudoers.d whose names contain a `.`. Staging beside the
    # target (same filesystem) makes the final mv atomic, so no sudo invocation
    # can ever read a half-written grant.
    install -o root -g root -m 0440 "${tmp}" "${dst}.new"
    mv -f "${dst}.new" "${dst}"
    rm -f "${tmp}"
}

if [ -d /etc/sudoers.d ]; then
    # The grant names the account literally, so the shipped file and DEPLOY_USER
    # must agree — otherwise the apply would install a grant for a different
    # user and the deploy would fail later with "a password is required"
    # instead of naming the mismatch here.
    if ! grep -q "^${DEPLOY_USER} ALL=(root)" "${SRC}/sudoers/kajianq-deploy"; then
        echo "apply: ${SRC}/sudoers/kajianq-deploy does not grant ${DEPLOY_USER} — name drift" >&2
        exit 1
    fi
    install_sudoers
else
    echo "apply: /etc/sudoers.d is missing — the deploy grant cannot be installed" >&2
    exit 1
fi

# The deploy key. Never from the repository (it is public) and never from argv
# in CI: the workflow writes it to a file the runner deletes when the job ends.
# `--deploy-pubkey` is the provisioning-time path; the setup doc also carries the
# manual command for moving the existing deploy keys off the admin account.
if [ -n "${DEPLOY_PUBKEY}" ]; then
    if [ ! -f "${DEPLOY_PUBKEY}" ]; then
        echo "apply: --deploy-pubkey ${DEPLOY_PUBKEY} not found" >&2
        exit 1
    fi
    # `|| true`: under `set -o pipefail` a getent miss on a not-yet-created
    # account would otherwise abort the whole apply, which would make --dry-run
    # unusable on a fresh box — the one case it is most useful in.
    deploy_home="$(getent passwd "${DEPLOY_USER}" | cut -d: -f6 || true)"
    if [ -z "${deploy_home}" ]; then
        echo "apply: cannot resolve ${DEPLOY_USER}'s home directory — account missing?" >&2
        exit 1
    fi
    run install -d -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" -m 0700 "${deploy_home}/.ssh"
    # Appended, not overwritten: a second key (the prod environment's key is a
    # separate pair) must not evict the first, and re-running the apply must not
    # depend on the key file still existing to stay valid.
    if [ "${DRY_RUN}" -eq 0 ]; then
        touch "${deploy_home}/.ssh/authorized_keys"
        chown "${DEPLOY_USER}:${DEPLOY_USER}" "${deploy_home}/.ssh/authorized_keys"
        chmod 0600 "${deploy_home}/.ssh/authorized_keys"
        while IFS= read -r key; do
            [ -n "${key}" ] || continue
            grep -qxF "${key}" "${deploy_home}/.ssh/authorized_keys" ||
                printf '%s\n' "${key}" >>"${deploy_home}/.ssh/authorized_keys"
        done <"${DEPLOY_PUBKEY}"
        log "installed the deploy key(s) from ${DEPLOY_PUBKEY}"
    else
        log "would: install the deploy key(s) from ${DEPLOY_PUBKEY}"
    fi
else
    log "no --deploy-pubkey given: leaving ${DEPLOY_USER}'s authorized_keys to the operator"
fi

# --- reverse proxy ----------------------------------------------------------
# The server block is rendered from the placeholder template, then installed
# under sites-available with the standard sites-enabled symlink, so disabling it
# is one `rm` and not an edit of a tracked file.
#
# Every `__KAJIANQ_*__` token a shipped config may carry is substituted here, so
# the function takes no placeholder list. The leftover-token check below is the
# reason: a rendered file that still contains a token is a half-applied config,
# and installing it is exactly the "looks done" failure this script's header
# forbids. That check exists because a placeholder in the backup unit's
# `ExecStart` went unsubstituted — systemd does not expand variables, so bun
# answered `Script not found "__KAJIANQ_BACKUP_SCRIPT__"` on every scheduled run
# and the nightly encrypted backup never once succeeded, while `is-active` on the
# timer stayed green. That unit now names a deployed artifact and carries no
# placeholder at all (#181); the check stays as the guard for anything that
# reintroduces one.
render() {
    local src="$1" dst="$2"
    local tmp
    tmp="$(mktemp)"
    sed \
        -e "s|__KAJIANQ_DOMAIN__|${KAJIANQ_DOMAIN}|g" \
        -e "s|__KAJIANQ_TLS_CERT__|${KAJIANQ_TLS_CERT}|g" \
        -e "s|__KAJIANQ_TLS_KEY__|${KAJIANQ_TLS_KEY}|g" \
        -e "s|__KAJIANQ_API_UPSTREAM__|${KAJIANQ_API_UPSTREAM}|g" \
        "${src}" >"${tmp}"
    # Fail closed on an unsubstituted token. A new placeholder in any shipped
    # config must be handled here or the apply stops naming it, instead of
    # installing a config whose brokenness surfaces later as a runtime error
    # nobody connects back to the install.
    if grep -qE '__KAJIANQ_[A-Z_]+__' "${tmp}"; then
        local leftover
        leftover="$(grep -oE '__KAJIANQ_[A-Z_]+__' "${tmp}" | sort -u | tr '\n' ' ')"
        rm -f "${tmp}"
        echo "apply: rendered ${src} still contains ${leftover}— add it to render()" >&2
        exit 1
    fi
    if [ "${DRY_RUN}" -eq 1 ]; then
        log "would: render ${src} -> ${dst}"
        rm -f "${tmp}"
        return 0
    fi
    install -o root -g root -m 0644 "${tmp}" "${dst}"
    rm -f "${tmp}"
}

if [ -d /etc/nginx ]; then
    render "${SRC}/nginx/kajianq.conf" /etc/nginx/sites-available/kajianq.conf
    run ln -sfn /etc/nginx/sites-available/kajianq.conf /etc/nginx/sites-enabled/kajianq.conf
    run nginx -t
    run systemctl reload nginx
else
    log "nginx not present — install it (apt-get install -y nginx) then re-run"
fi

# --- log rotation -----------------------------------------------------------
run install -o root -g root -m 0644 "${SRC}/logrotate/kajianq-proxy" /etc/logrotate.d/kajianq-proxy
run install -o root -g root -m 0644 "${SRC}/logrotate/kajianq-postgres" /etc/logrotate.d/kajianq-postgres
# --debug parses the config without rotating anything; a syntax error must fail
# the apply rather than surface as a silent rotation failure weeks later.
run logrotate --debug /etc/logrotate.d/kajianq-proxy
run logrotate --debug /etc/logrotate.d/kajianq-postgres

# --- API log retention ------------------------------------------------------
run install -d -o root -g root -m 0755 /etc/systemd/journald.conf.d
run install -o root -g root -m 0644 "${SRC}/journald/kajianq.conf" /etc/systemd/journald.conf.d/kajianq.conf
run systemctl restart systemd-journald

# --- Postgres ---------------------------------------------------------------
PG_CONF_DIR="$(ls -d /etc/postgresql/*/main/conf.d 2>/dev/null | head -1 || true)"
if [ -n "${PG_CONF_DIR}" ]; then
    run install -o root -g root -m 0644 "${SRC}/postgres/99-kajianq.conf" "${PG_CONF_DIR}/99-kajianq.conf"
    run systemctl restart postgresql
else
    log "no Debian Postgres conf.d found — install postgresql then re-run to apply the log/reachability posture"
fi

# --- API service ------------------------------------------------------------
run install -o root -g root -m 0644 "${SRC}/systemd/kajianq-api.service" /etc/systemd/system/kajianq-api.service

# --- session-reclamation cron (ADR-0017, ADR-0044 decision 7) ---------------
# The nightly reclamation used to be a Cloudflare Worker cron trigger; on the
# VPS it is a systemd timer invoking the dedicated entry. Both units are
# config-as-code, so the schedule is installed and enabled here rather than as a
# hand-copied crontab line.
run install -o root -g root -m 0644 "${SRC}/systemd/kajianq-cron.service" /etc/systemd/system/kajianq-cron.service
run install -o root -g root -m 0644 "${SRC}/systemd/kajianq-cron.timer" /etc/systemd/system/kajianq-cron.timer

# --- backup schedule --------------------------------------------------------
# The unit is installed verbatim: its ExecStart names a DEPLOYED artifact
# (api/backup.js), so there is no placeholder to render and nothing here reads
# the repository checkout. The bundle is shipped by the deploy path, which is
# what puts this unit's code under the same update mechanism as the API's
# (#181) — it used to execute whatever revision sat in /srv/kajianq-src, which
# the deploy never touched.
run install -o root -g root -m 0644 "${SRC}/systemd/kajianq-backup.service" /etc/systemd/system/kajianq-backup.service
run install -o root -g root -m 0644 "${SRC}/systemd/kajianq-backup.timer" /etc/systemd/system/kajianq-backup.timer
run systemctl daemon-reload

# The unit's ExecStart target is shipped by the DEPLOY path, not by this script
# (which is why nothing here renders a path into it). On a box where the deploy
# has not run yet the file is legitimately absent, so this warns rather than
# fails — but it names the consequence, because a unit whose target does not
# exist fails on its 03:15 run with an error nobody is watching for.
if [ "${DRY_RUN}" -eq 0 ] && [ ! -f /srv/kajianq/api/backup.js ]; then
    log "WARNING: /srv/kajianq/api/backup.js is absent — run provision/vps/deploy/deploy.sh to ship it,"
    log "         otherwise kajianq-backup.service cannot execute (it fails at 03:15, not here)"
fi

# Clear a failed state recorded against the PREVIOUS unit definition. The backup
# unit failed on every run under its old definition (#181); that failure is
# attached to the unit NAME, so it would otherwise survive this install and make
# `systemctl status` report a defect that no longer exists. Only the failure
# state is cleared — the run history stays in the journal, and the deploy checks
# the unit's next real run, which is the only thing that proves it works.
run systemctl reset-failed kajianq-backup.service
# Enabled, not started: the API needs its env file and the cutover before it can
# serve. Enabling now means the box comes up hardened instead of accidentally
# serving with default logging.
run systemctl enable kajianq-api.service
# Same posture for the reclamation: enabled, so the schedule is live as soon as
# the API env file exists; it starts working when the cutover starts serving.
run systemctl enable kajianq-cron.timer
# The timer is enabled --now: backups must exist for the restore drill to be
# meaningful, and a timer that waits for a manual start is the failure B2
# guards against. The first backup is still run by hand (setup doc step 5) so
# the one-time `restic init` is observed before any scheduled run.
run systemctl enable --now kajianq-backup.timer

log "done. Verify with: systemctl status kajianq-api; systemctl list-timers kajianq-backup.timer kajianq-cron.timer; logrotate --debug /etc/logrotate.d/kajianq-proxy"
log "verify the deploy grant: sudo -l -U ${DEPLOY_USER} (expect exactly two systemctl commands)"
log "next: the one-time backup-repository init in docs/VPS-SETUP.md (before the timer's first scheduled run)"
log "next: fill in /etc/kajianq/api.env from provision/vps/api.env.example (placeholders out, mode 0600) — the API unit cannot start without it, and without KAJIANQ_WEB_ROOT the SPA would 503 while health stays green"
