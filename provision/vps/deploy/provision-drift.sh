#!/usr/bin/env bash
# provision/vps/deploy/provision-drift.sh — does the box hold the provisioned
# files this checkout has?
#
# The deploy ships code and restarts units, but it does not provision: a file
# under provision/vps/ takes effect on the box only when an operator runs
# provision/vps/apply.sh there. Without a check, a merged change to a unit, a
# script or a config stays inert on the box while the deploy reports healthy.
#
# Two modes, one script:
#
#   --emit-manifest <checkout>   runs where the checkout is (the deploy machine)
#                                and prints one line per artifact: the rows
#                                `apply.sh --list-artifacts` prints, plus the
#                                source hash (and, for a rendered config, the
#                                template) that only the checkout can supply.
#
#   --check [--root <dir>]       runs ON the box, piped over ssh by deploy.sh;
#                                reads that manifest on stdin (or
#                                --manifest-base64, which is how the deploy
#                                passes it) and compares every installed copy.
#
# Read-only: it stats and hashes, never writes. --root exists so the tests can
# drive the box-side half against a fixture tree; the deploy passes nothing and
# checks /.
#
# The artifact set is not enumerated here: it comes from apply.sh's own table
# through --list-artifacts, so the set this check compares and the set apply.sh
# installs are one list.
#
# The comparison depends on the kind apply.sh reports:
#   config   the installed bytes must hash to the checkout's source bytes
#   render   the __KAJIANQ_* tokens are values only the box's proxy.env holds,
#            so each one matches any text; every other byte must match the
#            template. A stale template is drift; a different domain is not.
#   sudoers  /etc/sudoers.d/kajianq-deploy is 0440 root:root, unreadable from
#            the deploy identity by design, so it is compared by owner, mode
#            and size. The deploy's own privileged calls are the functional
#            test of what the grant authorizes; widening the grant to read the
#            file would trade that boundary for a weaker check.
#
# Usage: bash provision-drift.sh --emit-manifest <checkout>
#        bash provision-drift.sh --check [--root <dir>] [--manifest-base64 <value>]

set -euo pipefail

ROOT=""
MODE=""
CHECKOUT=""
MANIFEST_B64=""

usage() {
    cat >&2 <<'EOF'
usage: provision-drift.sh --emit-manifest <checkout>
       provision-drift.sh --check [--root <dir>] [--manifest-base64 <value>]
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --emit-manifest)
            MODE=emit
            CHECKOUT="${2:?--emit-manifest needs a checkout path}"
            shift 2
            ;;
        --check)
            MODE=check
            shift
            ;;
        --root)
            ROOT="${2:?--root needs a path}"
            shift 2
            ;;
        --manifest-base64)
            MANIFEST_B64="${2:?--manifest-base64 needs a value}"
            shift 2
            ;;
        *)
            echo "deploy: provision-drift: unknown argument: $1" >&2
            usage
            exit 2
            ;;
    esac
done

[ -n "${MODE}" ] || {
    usage
    exit 2
}

# One line per artifact, completing apply.sh's table with what only the
# checkout knows: the source bytes' hash, their size, and the render template.
emit_manifest() {
    local checkout="$1" artifacts name kind src dst owner group mode
    local path sha bytes payload
    artifacts="$(bash "${checkout}/provision/vps/apply.sh" --list-artifacts)"
    while IFS='|' read -r name kind src dst owner group mode; do
        [ -n "${name}" ] || continue
        path="${checkout}/provision/vps/${src}"
        if [ ! -f "${path}" ]; then
            echo "deploy: ${path} is missing from the checkout" >&2
            exit 1
        fi
        sha="$(sha256sum -- "${path}" | cut -d' ' -f1)"
        bytes="$(stat -c %s -- "${path}")"
        payload=""
        if [ "${kind}" = "render" ]; then
            payload="$(base64 -w0 < "${path}")"
        fi
        printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
            "${name}" "${kind}" "${src}" "${dst}" "${owner}" "${group}" "${mode}" \
            "${sha}" "${bytes}" "${payload}"
    done <<< "${artifacts}"
}

FAILURES=0
CHECKED=0

refuse() {
    local line
    for line in "$@"; do
        printf 'deploy: %s\n' "${line}" >&2
    done
    FAILURES=$((FAILURES + 1))
}

# Resolve a destination from the table. A destination may be a glob — the
# Postgres conf.d path carries the server's major version — and the first
# existing match is the file apply.sh's `ls -d ... | head -1` installs to.
resolve_destination() {
    local dst="$1" pattern="${ROOT%/}/${1#/}" candidate
    case "${pattern}" in
        *'*'*)
            # shellcheck disable=SC2086 # the glob IS the destination
            for candidate in ${pattern}; do
                if [ -e "${candidate}" ]; then
                    printf '%s\n' "${candidate}"
                    return 0
                fi
            done
            return 1
            ;;
    esac
    if [ -e "${pattern}" ]; then
        printf '%s\n' "${pattern}"
        return 0
    fi
    return 1
}

# Compare a rendered config against its repository template. Each
# __KAJIANQ_*__ token stands for a value from the box's proxy.env, so it matches
# any text; every other character must match its line. The line count must
# match too, which catches a template that gained or lost a line.
render_matches() {
    local installed="$1" template_b64="$2" template line actual regex total n=0
    template="$(mktemp)"
    if ! printf '%s' "${template_b64}" | base64 -d >"${template}"; then
        rm -f "${template}"
        return 1
    fi
    while IFS= read -r line || [ -n "${line}" ]; do
        n=$((n + 1))
        actual="$(sed -n "${n}p" -- "${installed}")"
        case "${line}" in
            *'__KAJIANQ_'*)
                regex="$(printf '%s' "${line}" |
                    sed -e 's/[][\.^$*+?(){}|]/\\&/g' -e 's/__KAJIANQ_[A-Z_]*__/.*/g')"
                if ! [[ "${actual}" =~ ^${regex}$ ]]; then
                    rm -f "${template}"
                    return 1
                fi
                ;;
            *)
                if [ "${actual}" != "${line}" ]; then
                    rm -f "${template}"
                    return 1
                fi
                ;;
        esac
    done <"${template}"
    total="$(wc -l <"${installed}")"
    rm -f "${template}"
    if [ "${total}" -ne "${n}" ]; then
        return 1
    fi
    return 0
}

check_manifest() {
    local manifest="$1" name kind src dst owner group mode sha bytes payload
    local installed actual
    while IFS='|' read -r name kind src dst owner group mode sha bytes payload; do
        [ -n "${name}" ] || continue
        CHECKED=$((CHECKED + 1))
        if ! installed="$(resolve_destination "${dst}")"; then
            refuse \
                "${dst} is not installed — the checkout installs provision/vps/${src}, so run provision/vps/apply.sh on the box" \
                "the deploy refuses a box whose provisioned files do not match the checkout"
            continue
        fi
        actual="$(stat -c '%U:%G:%a' -- "${installed}")"
        if [ "${actual}" != "${owner}:${group}:${mode}" ]; then
            refuse \
                "${dst} is ${actual}; the checkout installs provision/vps/${src} as ${owner}:${group}:${mode} — run provision/vps/apply.sh on the box"
            continue
        fi
        case "${kind}" in
            config)
                actual="$(sha256sum -- "${installed}" | cut -d' ' -f1)"
                if [ "${actual}" != "${sha}" ]; then
                    refuse \
                        "${dst} differs from provision/vps/${src} — run provision/vps/apply.sh on the box"
                fi
                ;;
            render)
                if ! render_matches "${installed}" "${payload}"; then
                    refuse \
                        "${dst} does not match provision/vps/${src} (placeholder values aside) — run provision/vps/apply.sh on the box"
                fi
                ;;
            sudoers)
                actual="$(stat -c %s -- "${installed}")"
                if [ "${actual}" != "${bytes}" ]; then
                    refuse \
                        "${dst} is ${actual} bytes; the checkout's provision/vps/${src} installs ${bytes} — run provision/vps/apply.sh on the box"
                fi
                ;;
            *)
                refuse "${dst} has an unknown artifact kind in the manifest (${kind})"
                ;;
        esac
    done <<< "${manifest}"
}

if [ "${MODE}" = "emit" ]; then
    emit_manifest "${CHECKOUT}"
    exit 0
fi

MANIFEST=""
if [ -n "${MANIFEST_B64}" ]; then
    MANIFEST="$(printf '%s' "${MANIFEST_B64}" | base64 -d)"
else
    MANIFEST="$(cat)"
fi
if [ -z "${MANIFEST}" ]; then
    echo "deploy: provision-drift: empty manifest — the deploy had nothing to compare" >&2
    exit 2
fi

check_manifest "${MANIFEST}"

if [ "${FAILURES}" -ne 0 ]; then
    printf 'deploy: %s of %s provisioned artifact(s) do not match the checkout\n' \
        "${FAILURES}" "${CHECKED}" >&2
    printf 'deploy: run provision/vps/apply.sh on the box from a checkout of the revision being deployed, then deploy again\n' >&2
    exit 1
fi
printf 'deploy: provisioned artifacts match the checkout (%s)\n' "${CHECKED}"
