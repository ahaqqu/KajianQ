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
# Changes no installed state: it stats, hashes and reads links. Comparing a
# rendered config writes one short-lived file under /tmp (removed before the
# script returns); nothing on the box is installed, edited or enabled.
# --root exists so the tests can drive the box-side half against a fixture tree;
# the deploy passes nothing and checks /.
#
# The artifact set is not enumerated here: it comes from apply.sh's own table
# through --list-artifacts, so the set this check compares and the set apply.sh
# installs are one list.
#
# The comparison depends on the kind apply.sh reports:
#   config   the installed bytes must hash to the checkout's source bytes
#   render   the __KAJIANQ_* tokens are values only the box's proxy.env holds,
#            so each one matches any text up to the directive's `;`; every other
#            byte must match the template. A stale template, or a second
#            directive appended to a placeholder line, is drift; a different
#            domain is not.
#   link     a symlink apply.sh places (the nginx sites-enabled link) is compared
#            by its target: a link missing, retargeted at an older copy, or
#            replaced by a regular file is drift.
#   sudoers  /etc/sudoers.d/kajianq-deploy is 0440 root:root, unreadable from
#            the deploy identity by design, so it is compared by owner, mode
#            and size. The deploy's own privileged calls are the functional
#            test of what the grant authorizes; widening the grant to read the
#            file would trade that boundary for a weaker check.
#
# A destination may carry the server's major version in a directory glob (the
# Postgres conf.d path). apply.sh resolves the first existing directory and
# skips the row when there is none, so this check skips it too: it never refuses
# a posture the box has no directory to hold. A skipped row is named and is not
# counted as compared; the green line reports it.
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
# A link row carries its target in the source field and no hash or bytes.
emit_manifest() {
    local checkout="$1" artifacts name kind src dst owner group mode
    local path sha bytes payload
    artifacts="$(bash "${checkout}/provision/vps/apply.sh" --list-artifacts)"
    while IFS='|' read -r name kind src dst owner group mode; do
        [ -n "${name}" ] || continue
        if [ "${kind}" = "link" ]; then
            printf '%s|%s|%s|%s|%s|%s|%s|||\n' \
                "${name}" "${kind}" "${src}" "${dst}" "${owner}" "${group}" "${mode}"
            continue
        fi
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
SKIPPED=0

refuse() {
    local line
    for line in "$@"; do
        printf 'deploy: %s\n' "${line}" >&2
    done
    FAILURES=$((FAILURES + 1))
}

# Resolve a destination from the table. A destination may be a glob — the
# Postgres conf.d path carries the server's major version — and apply.sh picks
# the first existing DIRECTORY (`ls -d .../conf.d | head -1`), then appends the
# file name. Resolving the first existing file instead would let a matching copy
# under a later major version hide a target apply.sh never wrote. With no
# directory at all apply.sh skips the row and exits 0, so this returns 2: the
# checker skips the same row rather than refusing a posture apply.sh cannot
# place (a refusal whose remedy — run apply.sh — would only skip again).
resolve_destination() {
    local dst="$1" pattern="${ROOT%/}/${1#/}" dir base candidate
    case "${pattern}" in
        *'*'*)
            dir="$(dirname "${pattern}")"
            base="$(basename "${pattern}")"
            case "${dir}" in
                *'*'*)
                    # shellcheck disable=SC2086 # the glob IS the destination
                    for candidate in ${dir}; do
                        if [ -d "${candidate}" ]; then
                            printf '%s/%s\n' "${candidate}" "${base}"
                            return 0
                        fi
                    done
                    # The literal glob reached no directory: apply.sh's
                    # `ls -d ... | head -1 || true` is empty for this row too.
                    return 2
                    ;;
                *)
                    # A glob in the file name itself: first existing match.
                    # shellcheck disable=SC2086
                    for candidate in ${pattern}; do
                        if [ -e "${candidate}" ]; then
                            printf '%s\n' "${candidate}"
                            return 0
                        fi
                    done
                    ;;
            esac
            return 1
            ;;
    esac
    # -L as well as -e: a symlink whose target is absent still exists as an
    # installed artifact, and the link branch reports the real mismatch.
    if [ -e "${pattern}" ] || [ -L "${pattern}" ]; then
        printf '%s\n' "${pattern}"
        return 0
    fi
    return 1
}

# Compare a rendered config against its repository template. Each
# __KAJIANQ_*__ token stands for a value from the box's proxy.env, so it matches
# any text up to the directive's `;`: a placeholder is a directive's value, and
# a second directive appended to the same line is a hand edit, not a value. The
# line count must match too, which catches a template that gained or lost a line.
#
# On a mismatch this prints the first difference on stdout and returns 1; on a
# match it prints nothing and returns 0. The reason travels as the function's
# output, so a call site inside a command substitution still carries it.
render_matches() {
    local installed="$1" template_b64="$2" template line actual regex total n=0
    if ! template="$(mktemp)"; then
        printf 'comparison scratch file could not be created'
        return 1
    fi
    if ! printf '%s' "${template_b64}" | base64 -d >"${template}" 2>/dev/null; then
        printf 'the template could not be decoded from the manifest'
        rm -f "${template}"
        return 1
    fi
    while IFS= read -r line || [ -n "${line}" ]; do
        n=$((n + 1))
        actual="$(sed -n "${n}p" -- "${installed}")"
        case "${line}" in
            *'__KAJIANQ_'*)
                regex="$(printf '%s' "${line}" |
                    sed -e 's/[][\.^$*+?(){}|]/\\&/g' -e 's/__KAJIANQ_[A-Z_]*__/[^;]*/g')"
                if ! [[ "${actual}" =~ ^${regex}$ ]]; then
                    printf 'line %s differs: installed %s, template %s' \
                        "${n}" "'${actual}'" "'${line}'"
                    rm -f "${template}"
                    return 1
                fi
                ;;
            *)
                if [ "${actual}" != "${line}" ]; then
                    printf 'line %s differs: installed %s, template %s' \
                        "${n}" "'${actual}'" "'${line}'"
                    rm -f "${template}"
                    return 1
                fi
                ;;
        esac
    done <"${template}"
    total="$(wc -l <"${installed}")"
    rm -f "${template}"
    if [ "${total}" -ne "${n}" ]; then
        printf 'the installed copy has %s lines, the template has %s' "${total}" "${n}"
        return 1
    fi
    return 0
}

check_manifest() {
    local manifest="$1" name kind src dst owner group mode sha bytes payload
    local installed actual expected status reason
    while IFS='|' read -r name kind src dst owner group mode sha bytes payload; do
        [ -n "${name}" ] || continue
        status=0
        installed="$(resolve_destination "${dst}")" || status=$?
        if [ "${status}" -eq 2 ]; then
            SKIPPED=$((SKIPPED + 1))
            printf 'deploy: no directory matches %s — apply.sh skips this row too, so it is not compared\n' \
                "$(dirname "${dst}")" >&2
            continue
        fi
        CHECKED=$((CHECKED + 1))
        if [ "${status}" -ne 0 ]; then
            case "${kind}" in
                link)
                    refuse \
                        "${dst} is not installed — the checkout creates it as a link to ${src}, so run provision/vps/apply.sh on the box" \
                        "the deploy refuses a box whose provisioned files do not match the checkout"
                    ;;
                *)
                    refuse \
                        "${dst} is not installed — the checkout installs provision/vps/${src}, so run provision/vps/apply.sh on the box" \
                        "the deploy refuses a box whose provisioned files do not match the checkout"
                    ;;
            esac
            continue
        fi
        if [ "${kind}" = "link" ]; then
            if [ ! -L "${installed}" ]; then
                refuse \
                    "${dst} is not a symlink — the checkout links it to ${src} — run provision/vps/apply.sh on the box"
                continue
            fi
            actual="$(readlink -- "${installed}")"
            expected="${src}"
            if [ -n "${ROOT}" ]; then
                expected="${ROOT%/}${src}"
            fi
            if [ "${actual}" != "${expected}" ]; then
                refuse \
                    "${dst} points at ${actual}; the checkout links it to ${src} — run provision/vps/apply.sh on the box"
            fi
            continue
        fi
        # A versioned destination resolves to the directory apply.sh targets, so
        # the file it would write can be absent while an older version's copy
        # exists. That is drift, and the path named is the one apply.sh targets.
        if [ ! -e "${installed}" ]; then
            refuse \
                "${installed} is not installed — the checkout installs provision/vps/${src}, so run provision/vps/apply.sh on the box" \
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
                        "${dst} differs from provision/vps/${src} (checkout sha256 ${sha:0:12}, installed ${actual:0:12}) — run provision/vps/apply.sh on the box"
                fi
                ;;
            render)
                if ! reason="$(render_matches "${installed}" "${payload}")"; then
                    refuse \
                        "${dst} does not match provision/vps/${src} (placeholder values aside): ${reason} — run provision/vps/apply.sh on the box"
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
        "${FAILURES}" "$((CHECKED + SKIPPED))" >&2
    printf 'deploy: run provision/vps/apply.sh on the box from a checkout of the revision being deployed, then deploy again\n' >&2
    exit 1
fi
if [ "${SKIPPED}" -ne 0 ]; then
    printf 'deploy: provisioned artifacts match the checkout (%s of %s; %s skipped — no directory for the row, as apply.sh also skips it)\n' \
        "${CHECKED}" "$((CHECKED + SKIPPED))" "${SKIPPED}"
else
    printf 'deploy: provisioned artifacts match the checkout (%s)\n' "${CHECKED}"
fi
