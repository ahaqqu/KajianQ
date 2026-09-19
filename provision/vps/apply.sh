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
run systemctl daemon-reload
# Enabled, not started: the API needs its env file and the GDPR-E (#181)
# cutover before it can serve. Enabling now means the box comes up hardened
# instead of accidentally serving with default logging.
run systemctl enable kajianq-api.service

log "done. Verify with: systemctl status kajianq-api; logrotate --debug /etc/logrotate.d/kajianq-proxy"
log "next: the one-time backup-repository init in docs/VPS-HARDENING-RUNBOOK.md"
