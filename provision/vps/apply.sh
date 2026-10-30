#!/usr/bin/env bash
# FROZEN (ADR-0065). New host configuration does not belong here: it goes to the
# private ahaqqu/vps repository, whose root applier installs that repository's
# protected branch. This path is frozen rather than deleted because the deploy
# still compares the installed files against this checkout; it must keep working
# unchanged until the switchover retires it, at which point this script is
# deleted so the box has one writer.
#
# provision/vps/apply.sh — place the hardening configs on the VPS and enable the
# services (ADR-0043, issue #180).
#
# Run this ON the netcup VPS, as root, from a checkout of this repository:
#
#   sudo provision/vps/apply.sh --env /etc/kajianq/proxy.env
#
# The script is idempotent: every step either writes the repository's version of
# a file when the installed one differs, or enables an already-enabled unit.
# Nothing here touches data — it writes configuration, creates the service
# account and directories, and enables units. The backup repository's one-time
# `restic init` is a separate, deliberate step in docs/VPS-SETUP.md, because it
# mints the encryption key and must be recorded by the owner.
#
# Substitutions: every `__KAJIANQ_*` placeholder in the shipped configs is
# replaced from --env. No hostname, certificate path, or origin address is
# committed to the repository, so this file is the only place they appear — and
# it reads them from a root-only env file, not from argv.
#
# Usage:
#   provision/vps/apply.sh [--env <file>] [--dry-run] [--deploy-pubkey <file>]
#   provision/vps/apply.sh --list-artifacts
#
# --deploy-pubkey installs the given public key file into the deploy account's
# authorized_keys. Without it, the key step is left to the operator (the
# setup doc carries the command that moves the deploy keys off the admin
# account); a key is never read from the repository, which is public.
#
# --list-artifacts prints the artifact table — every artifact this script
# places, a file or the sites-enabled link, with its source, destination, owner,
# group and mode — and exits before the root and env-file checks, so it needs no
# provisioning rights. The deploy's drift preflight
# (provision/vps/deploy/provision-drift.sh) enumerates what to compare from that
# output, so the set it checks and the set this script installs are one table,
# not two lists that drift apart.
#
# Exit non-zero on the first failure: a half-applied hardening config is worse
# than an unapplied one, because it looks done.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="${REPO_DIR}/provision/vps"
ENV_FILE="/etc/kajianq/proxy.env"
DRY_RUN=0
DEPLOY_PUBKEY=""
LIST_ARTIFACTS=0

# The deploy identity is fixed, not configurable (#181, ADR-0044 decision 6).
# Three places must agree on it: this account here, the sudoers
# grant in provision/vps/sudoers/kajianq-deploy, and the CI variable VPS_USER
# that the deploy workflow passes as KAJIANQ_DEPLOY_USER. A configurable name
# would let the grant and the caller disagree, and the deploy would then fail
# with a confusing "password is required" rather than a named mismatch — so
# name drift is a lint failure (tests/scripts/vps-hardening.test.mjs), not a
# silent possibility.
DEPLOY_USER="kajianq-deploy"

# --- the provisioned artifact table -----------------------------------------
# Every artifact this script places, in one table. The install section below
# takes each one's source, destination, ownership and mode from here, and
# `--list-artifacts` prints the same rows for the deploy's drift preflight, so
# the set it compares and the set this script installs cannot disagree.
#
# Fields: name|kind|source|destination|owner|group|mode
#   config   installed verbatim through install_config(); source is a file under
#            provision/vps/
#   render   __KAJIANQ_* placeholders substituted from --env through render()
#   sudoers  parsed by `visudo -cf` through install_sudoers()
#   link     a symlink to another row's destination through install_link(); its
#            source is the absolute link TARGET, not a repository file, and its
#            mode is `-` because a symlink's mode is neither applied nor checked
# A destination may be a glob where the host's layout carries a value the
# repository cannot know: the Postgres config lives under the server's
# major-version directory. The glob resolves to the first existing directory,
# then the file name, which is what the install for that row does.
ARTIFACTS='
nginx-conf|render|nginx/kajianq.conf|/etc/nginx/sites-available/kajianq.conf|root|root|644
nginx-enabled|link|/etc/nginx/sites-available/kajianq.conf|/etc/nginx/sites-enabled/kajianq.conf|root|root|-
logrotate-proxy|config|logrotate/kajianq-proxy|/etc/logrotate.d/kajianq-proxy|root|root|644
logrotate-postgres|config|logrotate/kajianq-postgres|/etc/logrotate.d/kajianq-postgres|root|root|644
journald|config|journald/kajianq.conf|/etc/systemd/journald.conf.d/kajianq.conf|root|root|644
postgres|config|postgres/99-kajianq.conf|/etc/postgresql/*/main/conf.d/99-kajianq.conf|root|root|644
api-unit|config|systemd/kajianq-api.service|/etc/systemd/system/kajianq-api.service|root|root|644
cron-unit|config|systemd/kajianq-cron.service|/etc/systemd/system/kajianq-cron.service|root|root|644
cron-timer|config|systemd/kajianq-cron.timer|/etc/systemd/system/kajianq-cron.timer|root|root|644
backup-marker|config|backup/kajianq-backup-pending.sh|/usr/local/sbin/kajianq-backup-pending|root|root|755
backup-unit|config|systemd/kajianq-backup.service|/etc/systemd/system/kajianq-backup.service|root|root|644
backup-timer|config|systemd/kajianq-backup.timer|/etc/systemd/system/kajianq-backup.timer|root|root|644
deploy-grant|sudoers|sudoers/kajianq-deploy|/etc/sudoers.d/kajianq-deploy|root|root|440
'

# Validate the table at load, before `--list-artifacts` or an install reads a
# row. A mode is the string `stat -c %a` prints — the octal value without a
# leading zero — because that is what the drift check compares an installed file
# against: `install -m 0440` installs 0440 while `stat -c %a` prints 440, so a
# `0440` cell would install one mode and the deploy would demand another,
# reddening every check until someone edited the table. Rejecting the cell here
# keeps the install and the comparison on one spelling. A link's mode is `-`,
# which is neither applied nor compared.
validate_artifact_table() {
    local row name kind src dst owner group mode
    while IFS= read -r row; do
        [ -n "${row}" ] || continue
        IFS='|' read -r name kind src dst owner group mode <<< "${row}"
        case "${kind}" in
            config | render | sudoers)
                case "${mode}" in
                    0 | [1-7] | [1-7][0-7] | [1-7][0-7][0-7] | [1-7][0-7][0-7][0-7]) ;;
                    *)
                        echo "apply: ${name} has mode ${mode}; write the form stat -c %a prints, with no leading zero (440, not 0440)" >&2
                        exit 1
                        ;;
                esac
                ;;
            link)
                if [ "${mode}" != "-" ]; then
                    echo "apply: ${name} is a link and its mode must be '-', not ${mode}" >&2
                    exit 1
                fi
                ;;
            *)
                echo "apply: ${name} has unknown artifact kind ${kind}" >&2
                exit 1
                ;;
        esac
    done <<< "${ARTIFACTS}"
}

validate_artifact_table

list_artifacts() {
    local row
    while IFS= read -r row; do
        [ -n "${row}" ] || continue
        printf '%s\n' "${row}"
    done <<< "${ARTIFACTS}"
}

artifact_spec() {
    local name="$1" row
    while IFS= read -r row; do
        [ -n "${row}" ] || continue
        case "${row}" in
            "${name}|"*) printf '%s\n' "${row}"; return 0 ;;
        esac
    done <<< "${ARTIFACTS}"
    echo "apply: no provisioned artifact named ${name}" >&2
    return 1
}

# The install dispatcher: every file this script places goes through the table,
# so the rows `--list-artifacts` prints and the rows installed here are the same
# rows. The helpers it names are defined further down, before the first call
# that reaches them.
install_artifact() {
    local name="$1" dst_override="${2:-}"
    local spec kind src dst owner group mode
    spec="$(artifact_spec "${name}")" || exit 1
    IFS='|' read -r _kind_name kind src dst owner group mode <<< "${spec}"
    if [ -n "${dst_override}" ]; then
        dst="${dst_override}"
    fi
    if [ "${kind}" != "link" ]; then
        src="${SRC}/${src}"
    fi
    case "${kind}" in
        config) install_config "${src}" "${dst}" "${owner}" "${group}" "${mode}" ;;
        render) render "${src}" "${dst}" "${owner}" "${group}" "${mode}" ;;
        sudoers) install_sudoers "${src}" "${dst}" "${owner}" "${group}" "${mode}" ;;
        link) install_link "${src}" "${dst}" ;;
        *)
            echo "apply: ${name} has unknown artifact kind ${kind}" >&2
            exit 1
            ;;
    esac
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
        --deploy-pubkey)
            DEPLOY_PUBKEY="${2:?--deploy-pubkey needs a path}"
            shift 2
            ;;
        --list-artifacts)
            LIST_ARTIFACTS=1
            shift
            ;;
        *)
            echo "apply: unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

# A read-only query: print what the install section places and exit before the
# root and env-file checks, so the deploy can enumerate the set it must compare
# without provisioning rights.
if [ "${LIST_ARTIFACTS}" -eq 1 ]; then
    list_artifacts
    exit 0
fi

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

# The deploy identity (#181, ADR-0044 decision 6): a real login
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
# The backup job's durable provenance record lives here: outside the deployed
# tree (so neither rsync nor the deploy identity's ownership can touch it),
# root-owned and world-readable, so the deploy identity can read a proof it
# cannot write. /var/lib is root-owned, which is what keeps a root-owned 0755
# directory here un-replaceable from the deploy account.
run install -d -o root -g root -m 0755 /var/lib/kajianq

# --- the deploy identity's root grant ---------------------------------------
# Installed only after `visudo -cf` parses the candidate: a malformed file in
# sudoers.d can lock sudo out of the box entirely, so the parse gates the
# install rather than following it. The candidate is validated first and moved
# into place after, so a failed parse leaves the previous grant intact.
install_sudoers() {
    local src="$1" dst="$2"
    local owner="${3:-root}" group="${4:-root}" mode="${5:-440}"
    local tmp
    if [ "${dst}" != "/etc/sudoers.d/${DEPLOY_USER}" ]; then
        echo "apply: the grant's destination ${dst} disagrees with ${DEPLOY_USER} — name drift" >&2
        exit 1
    fi
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
    # can ever read a half-written grant. The table's owner/group/mode are used
    # here too, so the grant is installed exactly as the drift check demands it.
    install -o "${owner}" -g "${group}" -m "${mode}" "${tmp}" "${dst}.new"
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
    install_artifact deploy-grant
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

# --- config install ---------------------------------------------------------
# `install` re-stamps a file's mtime even when the bytes are identical, and one
# mtime here is load-bearing: the deploy asserts that kajianq-backup.service has
# run SINCE ITS DEFINITION WAS INSTALLED, so re-installing an unchanged unit
# would report a unit that has been exercised — successfully, hours earlier — as
# never exercised, and fail the next deploy until a real backup run happens
# again. Writing only when something actually differs keeps that mtime meaning
# "this definition changed", which is what the deploy reads it as.
#
# Ownership, mode and a symlinked destination count as differences: a file left
# at the wrong mode, or pointing somewhere else, is not unchanged, and `install`
# is what fixes both.
install_config() {
    local src="$1" dst="$2"
    local owner="${3:-root}" group="${4:-root}" mode="${5:-644}"
    if [ "${DRY_RUN}" -eq 1 ]; then
        log "would: install ${src} -> ${dst}"
        return 0
    fi
    if [ -f "${dst}" ] && [ ! -L "${dst}" ] &&
        [ "$(stat -c '%U:%G:%a' "${dst}")" = "${owner}:${group}:${mode}" ] &&
        cmp -s "${src}" "${dst}"; then
        log "unchanged: ${dst}"
        return 0
    fi
    install -o "${owner}" -g "${group}" -m "${mode}" "${src}" "${dst}"
}

# --- reverse proxy ----------------------------------------------------------
# The server block is rendered from the placeholder template, then installed
# under sites-available with the standard sites-enabled symlink, so disabling it
# is one `rm` and not an edit of a tracked file. Both placements are table rows,
# so the deploy's drift check covers the link as well as the block.
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
    local owner="${3:-root}" group="${4:-root}" mode="${5:-644}"
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
    install_config "${tmp}" "${dst}" "${owner}" "${group}" "${mode}"
    rm -f "${tmp}"
}

# --- the enabled site --------------------------------------------------------
# The sites-enabled link is provisioned state, not a convenience: nginx resolves
# it to decide which server block is live, so a link retargeted at an older copy
# leaves the box serving a block this checkout no longer describes. The table's
# source for this row is the link target (an absolute path), and there is no
# ownership or mode to apply.
install_link() {
    local target="$1" dst="$2"
    run ln -sfn "${target}" "${dst}"
}

if [ -d /etc/nginx ]; then
    install_artifact nginx-conf
    install_artifact nginx-enabled
    run nginx -t
    run systemctl reload nginx
else
    log "nginx not present — install it (apt-get install -y nginx) then re-run"
fi

# --- log rotation -----------------------------------------------------------
install_artifact logrotate-proxy
install_artifact logrotate-postgres
# --debug parses the config without rotating anything; a syntax error must fail
# the apply rather than surface as a silent rotation failure weeks later.
run logrotate --debug /etc/logrotate.d/kajianq-proxy
run logrotate --debug /etc/logrotate.d/kajianq-postgres

# --- API log retention ------------------------------------------------------
run install -d -o root -g root -m 0755 /etc/systemd/journald.conf.d
install_artifact journald
run systemctl restart systemd-journald

# --- Postgres ---------------------------------------------------------------
# The drift check resolves this same glob and, with no directory here, skips the
# row instead of refusing: a row this script cannot place is not one the check
# may demand.
PG_CONF_DIR="$(ls -d /etc/postgresql/*/main/conf.d 2>/dev/null | head -1 || true)"
if [ -n "${PG_CONF_DIR}" ]; then
    install_artifact postgres "${PG_CONF_DIR}/99-kajianq.conf"
    run systemctl restart postgresql
else
    log "no Debian Postgres conf.d found — install postgresql then re-run to apply the log/reachability posture"
fi

# --- API service ------------------------------------------------------------
install_artifact api-unit

# --- session-reclamation cron (ADR-0017, ADR-0044 decision 6) ---------------
# The nightly reclamation used to be a Cloudflare Worker cron trigger; on the
# VPS it is a systemd timer invoking the dedicated entry. Both units are
# config-as-code, so the schedule is installed and enabled here rather than as a
# hand-copied crontab line.
install_artifact cron-unit
install_artifact cron-timer

# --- backup schedule --------------------------------------------------------
# The unit's ExecStartPre marker is a root-owned script outside /etc and outside
# the deployed tree: /srv/kajianq belongs to the deploy identity and is rsynced
# with --delete, so a copy there could be rewritten by the very identity the
# record binds. It must exist for every start, including the starts where
# ExecStart cannot run — which is why it is not part of the job body.
#
# `755` is compared verbatim by install_config against `stat -c %a` (which
# prints 755, not 0755), so an unchanged copy is still left untouched.
install_artifact backup-marker

# The unit is installed verbatim: its ExecStart names a DEPLOYED artifact
# (api/backup.js), so there is no placeholder to render and nothing here reads
# the repository checkout. The bundle is shipped by the deploy path, which is
# what puts this unit's code under the same update mechanism as the API's
# (#181) — it used to execute whatever revision sat in /srv/kajianq-src, which
# the deploy never touched.
install_artifact backup-unit
install_artifact backup-timer
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
log "verify the deploy grant: sudo -l -U ${DEPLOY_USER} (expect the bridge: vps-deploy kajianq, the legacy commands and the read-only diagnostics)"
log "next: the one-time backup-repository init in docs/VPS-SETUP.md (before the timer's first scheduled run)"
log "next: fill in /etc/kajianq/api.env from provision/vps/api.env.example (placeholders out, mode 0600) — the API unit cannot start without it, and without KAJIANQ_WEB_ROOT the SPA would 503 while health stays green"
