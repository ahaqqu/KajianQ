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
# separate, deliberate step in docs/VPS-HARDENING-RUNBOOK.md, because it mints
# the encryption key and must be recorded by the owner.
#
# Substitutions: every `__KAJIANQ_*` placeholder in the shipped configs is
# replaced from --env. No hostname, certificate path, or origin address is
# committed to the repository, so this file is the only place they appear — and
# it reads them from a root-only env file, not from argv.
#
# Usage:
#   provision/vps/apply.sh [--env <file>] [--dry-run]
#
# Exit non-zero on the first failure: a half-applied hardening config is worse
# than an unapplied one, because it looks done.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="${REPO_DIR}/provision/vps"
ENV_FILE="/etc/kajianq/proxy.env"
DRY_RUN=0

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
# Fail closed on the first apply rather than trusting the runbook's chmod.
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
run install -d -o kajianq -g kajianq -m 0755 /srv/kajianq /srv/kajianq/api /srv/kajianq/web
run install -d -o root -g root -m 0700 /etc/kajianq

# --- reverse proxy ----------------------------------------------------------
# The server block is rendered from the placeholder template, then installed
# under sites-available with the standard sites-enabled symlink, so disabling it
# is one `rm` and not an edit of a tracked file.
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
# The backup script lives in the checked-out repository; the service unit
# carries a placeholder because systemd does not expand variables in
# ExecStart, so the real path is rendered here like every other substitute.
if [ ! -f "${SRC}/backup/kajianq-backup.mjs" ]; then
    echo "apply: ${SRC}/backup/kajianq-backup.mjs not found — the backup unit needs the repository checkout" >&2
    exit 1
fi
render "${SRC}/systemd/kajianq-backup.service" /etc/systemd/system/kajianq-backup.service
run install -o root -g root -m 0644 "${SRC}/systemd/kajianq-backup.timer" /etc/systemd/system/kajianq-backup.timer
run systemctl daemon-reload
# Enabled, not started: the API needs its env file and the cutover before it can
# serve. Enabling now means the box comes up hardened instead of accidentally
# serving with default logging.
run systemctl enable kajianq-api.service
# Same posture for the reclamation: enabled, so the schedule is live as soon as
# the API env file exists; it starts working when the cutover starts serving.
run systemctl enable kajianq-cron.timer
# The timer is enabled --now: backups must exist for the restore drill to be
# meaningful, and a timer that waits for a manual start is the failure B2
# guards against. The first backup is still run by hand (runbook step 5) so
# the one-time `restic init` is observed before any scheduled run.
run systemctl enable --now kajianq-backup.timer

log "done. Verify with: systemctl status kajianq-api; systemctl list-timers kajianq-backup.timer kajianq-cron.timer; logrotate --debug /etc/logrotate.d/kajianq-proxy"
log "next: the one-time backup-repository init in docs/VPS-HARDENING-RUNBOOK.md (before the timer's first scheduled run)"
