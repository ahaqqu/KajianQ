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
# One destination carries the server's major version in a directory glob (the
# Postgres conf.d path), and apply.sh's install section resolves exactly that
# row: `ls -d` takes the first match, directory or not, the file name is
# appended, and the row is skipped with a log line when nothing matches. This
# check mirrors that one row. It resolves the same first match and refuses an
# entry that is not a directory (the install into it would fail); it skips only
# where apply.sh skips, and it names the two skip states apart — no Postgres at
# all, versus Postgres installed with no conf.d, where the log/reachability
# posture is never applied.
#
# The version choice is the one place this check cannot see what apply.sh sees:
# apply.sh runs as root and expands the glob through directories root alone may
# enter, while this check runs as the deploy identity. Resolving as root would
# need privilege the preflight does not have and must not hold, so this check
# refuses instead of resolving a different version: every directory the
# pattern's expansion must enter — the static prefix, each `<ver>` under it,
# each `<ver>/main`, each `conf.d` — is tested for read and search, and the
# first one this identity cannot enter is refused rather than read as "no
# match". A version directory it cannot see is one root's expansion may still
# pick, and then apply.sh would write a directory this check never compared.
# Any other row whose destination carries a directory glob is refused because
# apply.sh hands that row's literal path to install and fails, so the check
# must not skip it uncompared. A skipped row is named and is not counted as
# compared; the green line reports it.
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
SKIPPED_NO_CONF_D=0
NON_APPLY_FAILURES=0
REFUSAL_LINES=()

# Failure text is held until the end, then printed after the count so each
# refusal keeps its own closing instruction and the generic apply.sh summary
# can be withheld from a refusal an apply cannot clear.
refuse() {
    local line
    for line in "$@"; do
        REFUSAL_LINES+=("${line}")
    done
    FAILURES=$((FAILURES + 1))
}

# A refusal an apply.sh run cannot clear: a path this identity cannot read, a
# destination only the Postgres row resolves through a glob, a conf.d that is
# not a directory, or a kind this check cannot compare. Running apply.sh over
# any of these leaves the condition in place and the next deploy refuses again,
# so the closing summary must not name it as the remedy.
refuse_uncleared_by_apply() {
    refuse "$@"
    NON_APPLY_FAILURES=$((NON_APPLY_FAILURES + 1))
}

# The one row whose destination apply.sh resolves through a versioned glob: its
# install section computes PG_CONF_DIR and logs a skip when the glob is empty.
# Every other row's destination reaches install literally, so a versioned
# destination there is a row apply.sh cannot place and this check refuses it.
VERSIONED_SKIP_ROW="postgres"

# A directory this identity cannot read and search, printed so a refusal names
# it; an absent directory is not printed — absence is a state the caller
# interprets. A glob expands to nothing under either, which is why a read
# failure anywhere on an expansion path has to be refused rather than read as
# "nothing matches".
unreadable_dir() {
    local path="$1"
    [ -e "${path}" ] || return 1
    if [ -r "${path}" ] && [ -x "${path}" ]; then
        return 1
    fi
    printf '%s\n' "${path}"
    return 0
}

# The first path in the static prefix's chain that this identity cannot read and
# search. An empty glob under an unsearchable ancestor is not evidence of an
# absent directory: every probe below it fails the same way, so a skip there
# would hide a tree the box has.
unsearchable_prefix() {
    local path="$1" parent
    while [ -n "${path}" ] && [ "${path}" != "/" ]; do
        if unreadable_dir "${path}"; then
            return 0
        fi
        parent="$(dirname "${path}")"
        [ "${parent}" != "${path}" ] || break
        path="${parent}"
    done
    return 1
}

# Every directory an expansion of a versioned pattern must enter below its
# static prefix: the matches of each glob component, and every fixed component
# below them. Prints the first one this identity cannot read and search, and
# returns 0; returns 1 when the whole expansion is visible here.
#
# Root ignores the bits that stop this identity, so a directory it cannot enter
# may still hold a version root's expansion picks. The refusal is what keeps
# this check from comparing one directory while apply.sh writes another.
unsearchable_expansion() {
    local path="$1" suffix="$2" component candidate entry
    suffix="${suffix#/}"
    [ -n "${suffix}" ] || return 1
    component="${suffix%%/*}"
    case "${suffix}" in
        */*) suffix="${suffix#*/}" ;;
        *) suffix="" ;;
    esac
    case "${component}" in
        *'*'*)
            # Matching the glob reads this directory; entering a match stats
            # that match's children.
            if unreadable_dir "${path}"; then
                return 0
            fi
            for entry in "${path}"/*; do
                [ -d "${entry}" ] || continue
                # shellcheck disable=SC2053 # the component IS the pattern
                [[ "${entry##*/}" == ${component} ]] || continue
                if unreadable_dir "${entry}"; then
                    return 0
                fi
                if unsearchable_expansion "${entry}" "${suffix}"; then
                    return 0
                fi
            done
            ;;
        *)
            candidate="${path%/}/${component}"
            [ -d "${candidate}" ] || return 1
            if unreadable_dir "${candidate}"; then
                return 0
            fi
            if unsearchable_expansion "${candidate}" "${suffix}"; then
                return 0
            fi
            ;;
    esac
    return 1
}

# Resolve a destination from the table. A destination may be a directory glob —
# the Postgres conf.d path carries the server's major version — and apply.sh
# picks the first match of `ls -d .../conf.d` (directory or not), then appends
# the file name. Resolving the first existing DIRECTORY instead would let a
# matching copy under a later major version hide a target apply.sh never wrote,
# and a regular file at conf.d would skip a row apply.sh resolves and fails.
#
# Returns 0 with the resolved path on stdout, or a status naming why not:
#   1  not installed (the caller refuses with the artifact's usual remedy)
#   2  the row apply.sh skips, with no static prefix on the box
#   3  the row apply.sh skips, with a static prefix but no match under it
#   4  a versioned destination on a row apply.sh does not resolve
#   5  the static prefix, or a directory its glob expands through, cannot be
#      read or searched by this identity
#   6  the glob matched an entry that is not a directory
# For 3, 5 and 6 the offending path is printed on stdout.
resolve_destination() {
    local name="$1" dst="$2" pattern="${ROOT%/}/${2#/}" dir base prefix found match candidate
    case "${pattern}" in
        *'*'*)
            dir="$(dirname "${pattern}")"
            base="$(basename "${pattern}")"
            case "${dir}" in
                *'*'*)
                    [ "${name}" = "${VERSIONED_SKIP_ROW}" ] || return 4
                    # The fixed path the glob expands under: the directory that
                    # holds the first glob component. That is the text before
                    # the `*` when it ends at a component boundary, and its
                    # parent when the `*` shares a component with fixed text.
                    prefix="${dir%%\**}"
                    case "${prefix}" in
                        */) prefix="${prefix%/}" ;;
                        *) prefix="$(dirname "${prefix}")" ;;
                    esac
                    [ -n "${prefix}" ] || prefix="/"
                    if found="$(unsearchable_prefix "${prefix}")"; then
                        printf '%s\n' "${found}"
                        return 5
                    fi
                    [ -e "${prefix}" ] || return 2
                    # Every directory below the prefix that the expansion must
                    # enter, before the first match is trusted: root resolves
                    # through directories this identity cannot.
                    if found="$(unsearchable_expansion "${prefix}" "${dir#"${prefix}"}")"; then
                        printf '%s\n' "${found}"
                        return 5
                    fi
                    # shellcheck disable=SC2086 # the glob IS the destination
                    match="$(ls -d ${dir} 2>/dev/null | head -1 || true)"
                    if [ -z "${match}" ]; then
                        printf '%s\n' "${prefix}"
                        return 3
                    fi
                    if [ ! -d "${match}" ]; then
                        printf '%s\n' "${match}"
                        return 6
                    fi
                    printf '%s/%s\n' "${match}" "${base}"
                    return 0
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
        installed="$(resolve_destination "${name}" "${dst}")" || status=$?
        case "${status}" in
            0) ;;
            2)
                SKIPPED=$((SKIPPED + 1))
                printf 'deploy: no directory matches %s — Postgres is not installed, so apply.sh skips this row too and it is not compared\n' \
                    "$(dirname "${dst}")" >&2
                continue
                ;;
            3)
                SKIPPED=$((SKIPPED + 1))
                SKIPPED_NO_CONF_D=$((SKIPPED_NO_CONF_D + 1))
                printf 'deploy: no conf.d directory under %s — Postgres is installed but its log/reachability posture is not applied on this box; install or repair Postgres, then run provision/vps/apply.sh\n' \
                    "${installed}" >&2
                continue
                ;;
            4)
                CHECKED=$((CHECKED + 1))
                refuse_uncleared_by_apply \
                    "${dst} carries a versioned destination, but apply.sh resolves a versioned destination only for the ${VERSIONED_SKIP_ROW} row — its literal path would reach install and fail" \
                    "repair the artifact table in provision/vps/apply.sh so only the ${VERSIONED_SKIP_ROW} row carries a directory glob, then deploy again — running apply.sh cannot place this row's literal path"
                continue
                ;;
            5)
                CHECKED=$((CHECKED + 1))
                refuse_uncleared_by_apply \
                    "cannot read or search ${installed} as $(id -un) — an unreadable path and an absent one both yield an empty glob, and root's apply.sh expands through paths this identity cannot enter, so ${dst} is refused instead of skipped" \
                    "make ${installed} readable and searchable for the deploy identity, then deploy again"
                continue
                ;;
            6)
                CHECKED=$((CHECKED + 1))
                refuse_uncleared_by_apply \
                    "${installed} is not a directory — apply.sh resolves the first conf.d match with ls -d and would fail to install provision/vps/${src} into it" \
                    "remove ${installed} or repair Postgres, then run provision/vps/apply.sh on the box and deploy again — apply.sh cannot install into a file"
                continue
                ;;
        esac
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
                refuse_uncleared_by_apply \
                    "${dst} has an unknown artifact kind in the manifest (${kind})" \
                    "repair the artifact table in provision/vps/apply.sh so the row names config, render, link or sudoers, then deploy again — apply.sh cannot change a kind this check does not compare"
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
    if [ "${NON_APPLY_FAILURES}" -ne 0 ]; then
        printf 'deploy: %s of %s provisioned artifact(s) could not be compared or do not match the checkout\n' \
            "${FAILURES}" "$((CHECKED + SKIPPED))" >&2
    else
        printf 'deploy: %s of %s provisioned artifact(s) do not match the checkout\n' \
            "${FAILURES}" "$((CHECKED + SKIPPED))" >&2
    fi
    for line in "${REFUSAL_LINES[@]}"; do
        printf 'deploy: %s\n' "${line}" >&2
    done
    if [ "${NON_APPLY_FAILURES}" -eq 0 ]; then
        printf 'deploy: run provision/vps/apply.sh on the box from a checkout of the revision being deployed, then deploy again\n' >&2
    fi
    exit 1
fi
if [ "${SKIPPED}" -ne 0 ]; then
    if [ "${SKIPPED_NO_CONF_D}" -ne 0 ]; then
        printf 'deploy: provisioned artifacts match the checkout (%s of %s; %s skipped — Postgres is installed but has no conf.d, so its log/reachability posture is not applied on this box)\n' \
            "${CHECKED}" "$((CHECKED + SKIPPED))" "${SKIPPED}"
    else
        printf 'deploy: provisioned artifacts match the checkout (%s of %s; %s skipped — Postgres is not installed, as apply.sh also skips the row)\n' \
            "${CHECKED}" "$((CHECKED + SKIPPED))" "${SKIPPED}"
    fi
else
    printf 'deploy: provisioned artifacts match the checkout (%s)\n' "${CHECKED}"
fi
