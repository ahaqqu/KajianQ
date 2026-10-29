#!/usr/bin/env bash
# provision/vps/deploy/migration-check.sh — refuse a deploy whose database is
# behind the checkout.
#
# Run by deploy.sh on the deploying machine before it builds, ships or restarts
# anything (the first preflight, docs/VPS-OPERATIONS.md §1.1). It reads the
# shared schema_migrations ledger through `bun run db:status:all:json` — the
# engine, domain and product migration sets share one database and one ledger —
# and refuses when any migration is pending. The machine report is a contract
# with `db-migrate.mjs status --json`: a report this script does not recognise
# refuses the deploy rather than reading as an empty pending list.
#
# The refusal is the point. A deploy never applies a migration (docs/
# VPS-OPERATIONS.md §2.3): applying is an operator action, and a release that
# needs a schema the box does not have must not ship. The post-deploy smoke
# cannot see that state — health, the anonymous mint and the chat page never
# touch the admin surface that fails closed with a 503 — so without this gate a
# green deploy would hide a half-migrated box until someone used the feature.
#
# The database listens on loopback only on the box (docs/VPS-OPERATIONS.md
# §2.8), so the check opens its own short-lived ssh tunnel and closes it on exit
# — the same shape the Staging smoke uses. DATABASE_URL must therefore name a loopback host
# and an explicit port: the tunnel binds that local port and forwards it to the
# box's 127.0.0.1:5432, and a URL naming any other host would make the check
# read a database the deploy does not touch. Passwords stay in the environment;
# nothing here prints the URL.
#
# Usage: migration-check.sh [--skip-migration-check]
#
# Environment:
#   DATABASE_URL               the deployment database, through the tunnel port
#   KAJIANQ_DB_TUNNEL_TARGET   ssh destination for the tunnel (user@host);
#                              deploy.sh sets it, so both the CI and operator
#                              paths share this file. Unset means DATABASE_URL
#                              is expected to be reachable as given (no tunnel).
#
# Exit 0 when the ledger is clean or the operator explicitly skips the check;
# exit 1, with `deploy:`-prefixed lines, on every state the check cannot prove
# clean: a missing or unusable DATABASE_URL, a tunnel that does not come up, a
# status command that fails, or any pending migration.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

SKIP_MIGRATION_CHECK=0
while [ $# -gt 0 ]; do
    case "$1" in
        --skip-migration-check)
            SKIP_MIGRATION_CHECK=1
            shift
            ;;
        *)
            echo "deploy: unknown argument: $1 (expected --skip-migration-check)" >&2
            exit 1
            ;;
    esac
done

SKIP_HINT="pass --skip-migration-check to deploy anyway — the deploy then proceeds against an unverified schema"

# Print each line as a deploy refusal and exit 1; keeps the states readable.
refuse() {
    local line
    for line in "$@"; do
        printf 'deploy: %s\n' "${line}" >&2
    done
    exit 1
}

# The single explicit escape hatch. An environment variable is deliberately not
# an alternative: a skipped migration check must be visible in the command that
# deployed, and CI must never pass the flag.
if [ "${SKIP_MIGRATION_CHECK}" -eq 1 ]; then
    printf '%s\n' "deploy: WARNING: --skip-migration-check given — deploying without reading the migration ledger" >&2
    exit 0
fi

if [ -z "${DATABASE_URL:-}" ]; then
    refuse \
        "DATABASE_URL is not set — cannot read the shared migration ledger" \
        "set it in the deploy env file (provision/vps/deploy/deploy.env.example) to the deployment database through the tunnel port, then deploy again" \
        "${SKIP_HINT}"
fi

# Parse only what the tunnel needs; the credentials half is never echoed.
case "${DATABASE_URL}" in
    postgres://* | postgresql://*) ;;
    *)
        refuse \
            "DATABASE_URL is not a postgres:// URL — cannot read the shared migration ledger" \
            "${SKIP_HINT}"
        ;;
esac

# scheme://[user[:password]@]host[:port][/database][?params] — strip the scheme,
# the database/params tail and the credentials, leaving host:port.
authority="${DATABASE_URL#*://}"
authority="${authority%%/*}"
authority="${authority##*@}"
host="${authority%%:*}"
if [ "${host}" = "${authority}" ]; then
    refuse \
        "DATABASE_URL names no port — it must name the tunnel's loopback port (e.g. 127.0.0.1:15433)" \
        "${SKIP_HINT}"
fi
port="${authority##*:}"
case "${host}" in
    127.0.0.1 | localhost) ;;
    *)
        refuse \
            "DATABASE_URL names host '${host}' — it must name a loopback host (127.0.0.1 or localhost), because the deploy reads the box's loopback-only database through its own ssh tunnel" \
            "${SKIP_HINT}"
        ;;
esac
case "${port}" in
    '' | *[!0-9]*)
        refuse \
            "DATABASE_URL names port '${port}' — it must be a number (the tunnel's local port)" \
            "${SKIP_HINT}"
        ;;
esac

# --- the tunnel -------------------------------------------------------------
# Backgrounded so the local process id is known and can be killed; the
# readiness probe below is what proves the forward is up. `BatchMode` keeps a
# missing or rejected key a failure this script can report instead of a prompt
# hanging a CI deploy, and `ExitOnForwardFailure` makes a bind error kill ssh
# rather than leave a half-open forward behind.
TUNNEL_PID=""
cleanup() {
    if [ -n "${TUNNEL_PID}" ]; then
        kill "${TUNNEL_PID}" 2>/dev/null || true
        wait "${TUNNEL_PID}" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# True when anything already listens on the tunnel's local port. `ss` is the
# direct question on a Linux deploy host; the fallback's bare connect is the
# same readiness signal the loop below uses.
port_is_taken() {
    if command -v ss >/dev/null 2>&1; then
        [ -n "$(ss -ltnH "sport = :$1" 2>/dev/null)" ]
    else
        (echo >"/dev/tcp/127.0.0.1/$1") 2>/dev/null
    fi
}

if [ -n "${KAJIANQ_DB_TUNNEL_TARGET:-}" ]; then
    # The readiness probe proves that *something* answers on the port, not that
    # this script's forward is what answers. A leftover forward from a run
    # killed with SIGKILL, or an operator's tunnel to another database, would
    # satisfy the probe and let the check report another ledger as clean. So the
    # port must be free before ssh is spawned: once it is, the only listener the
    # probe can reach is the forward below.
    if port_is_taken "${port}"; then
        refuse \
            "127.0.0.1:${port} is already bound — refusing to read a ledger through a tunnel this deploy does not own" \
            "close whatever holds the port (an operator tunnel, or a leftover forward from a killed run), then deploy again" \
            "${SKIP_HINT}"
    fi
    ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
        -o ExitOnForwardFailure=yes -o ConnectTimeout=10 \
        -N -L "127.0.0.1:${port}:127.0.0.1:5432" "${KAJIANQ_DB_TUNNEL_TARGET}" &
    TUNNEL_PID=$!
    tunnel_ready=0
    for ((attempt = 0; attempt < 100; attempt += 1)); do
        # A dead ssh — a refused key, a bind failure, an unreachable box — is
        # not a slow one: stop waiting and name the failure rather than
        # reporting a timeout as its cause.
        if ! kill -0 "${TUNNEL_PID}" 2>/dev/null; then
            break
        fi
        # A bare TCP connect is the readiness signal; the server logs and drops
        # the incomplete startup packet, which is why this probes once per loop
        # rather than retrying a full client handshake.
        if (echo >"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
            tunnel_ready=1
            break
        fi
        sleep 0.1
    done
    if [ "${tunnel_ready}" -ne 1 ]; then
        refuse \
            "could not open the database tunnel to ${KAJIANQ_DB_TUNNEL_TARGET} on 127.0.0.1:${port}" \
            "check: ssh ${KAJIANQ_DB_TUNNEL_TARGET} true" \
            "${SKIP_HINT}"
    fi
    # The probe can win the race against a bind that failed once ssh had already
    # connected, and ssh can die after the probe succeeded. Either way the port
    # may answer while this script no longer owns the forward, so the child is
    # re-checked right before the ledger is read.
    if ! kill -0 "${TUNNEL_PID}" 2>/dev/null; then
        refuse \
            "the database tunnel to ${KAJIANQ_DB_TUNNEL_TARGET} exited before the ledger was read — 127.0.0.1:${port} is not held by this deploy" \
            "check: ssh ${KAJIANQ_DB_TUNNEL_TARGET} true" \
            "${SKIP_HINT}"
    fi
fi

# --- the ledger -------------------------------------------------------------
# `status --json` prints one `{"applied":[…],"pending":[…]}` object per
# migration set (the keys in that order, one line each). Lines that are not that
# object — bun's command banners — are skipped; a report with no object, or one
# whose `pending` is not a list of plain JSON strings, refuses. Reading an
# unrecognised report as "nothing pending" is the silent failure this gate
# exists to close.
status_rc=0
status_output="$(cd "${REPO_DIR}" && bun run db:status:all:json 2>&1)" || status_rc=$?
if [ "${status_rc}" -ne 0 ]; then
    printf 'deploy: %s\n' \
        "the migration status could not be read — bun run db:status:all:json exited ${status_rc}" >&2
    if [ -n "${status_output}" ]; then
        while IFS= read -r line; do
            printf 'deploy:   %s\n' "${line}" >&2
        done <<<"${status_output}"
    fi
    refuse \
        "the deploy refuses before the build: an unverified schema is not a green deploy" \
        "fix the connection (docs/VPS-OPERATIONS.md §2.3), then deploy again" \
        "${SKIP_HINT}"
fi

report_re='^\{"applied":\[(.*)\],"pending":\[(.*)\]\}$'
pending_list_re='^"[^"\\]+"(,"[^"\\]+")*$'
pending=()
reports=0
while IFS= read -r line; do
    case "${line}" in
        "{"*"}") ;;
        *) continue ;;
    esac
    reports=$((reports + 1))
    if ! [[ "${line}" =~ ${report_re} ]]; then
        refuse \
            "the migration status is not the expected machine report (one JSON object with applied and pending arrays per set) — refusing to read an unrecognised report as a clean ledger" \
            "${SKIP_HINT}"
    fi
    pending_json="${BASH_REMATCH[2]}"
    if [ -z "${pending_json}" ]; then
        continue
    fi
    if ! [[ "${pending_json}" =~ ${pending_list_re} ]]; then
        refuse \
            "the migration status's pending list is not a list of plain JSON strings — refusing to read it as a clean ledger" \
            "${SKIP_HINT}"
    fi
    while IFS= read -r name; do
        pending+=("${name}")
    done < <(printf '%s\n' "${pending_json//\",\"/$'\n'}" | tr -d '"')
done <<<"${status_output}"
if [ "${reports}" -eq 0 ]; then
    refuse \
        "bun run db:status:all:json printed no machine-readable report — refusing to read an unreadable ledger as clean" \
        "${SKIP_HINT}"
fi

if [ "${#pending[@]}" -eq 0 ]; then
    printf '%s\n' "deploy: no pending migrations on the shared ledger"
    exit 0
fi

# The exact `db:up:*` command for a pending migration, from the migration set
# its file belongs to. Names are unique across sets; a name found in no set or
# in more than one (a corrupted checkout) falls back to the command covering all
# three, which is always safe.
migration_up_command() {
    local name="$1" hits=0 command=""
    if [ -f "${REPO_DIR}/packages/infra/migrations/${name}" ]; then
        hits=$((hits + 1))
        command="bun run db:up"
    fi
    if [ -f "${REPO_DIR}/packages/kajianq-domain/migrations/${name}" ]; then
        hits=$((hits + 1))
        command="bun run db:up:domain"
    fi
    if [ -f "${REPO_DIR}/apps/api/migrations/${name}" ]; then
        hits=$((hits + 1))
        command="bun run db:up:api"
    fi
    if [ "${hits}" -eq 1 ]; then
        printf '%s\n' "${command}"
    else
        printf '%s\n' "bun run db:up:all"
    fi
}

commands=()
for name in "${pending[@]}"; do
    candidate="$(migration_up_command "${name}")"
    seen=0
    index=0
    while [ "${index}" -lt "${#commands[@]}" ]; do
        if [ "${commands[${index}]}" = "${candidate}" ]; then
            seen=1
            break
        fi
        index=$((index + 1))
    done
    if [ "${seen}" -eq 0 ]; then
        commands+=("${candidate}")
    fi
done

printf 'deploy: %s\n' "pending migrations: ${pending[*]}" >&2
printf '%s\n' \
    "deploy: the deploy refuses before the build: the new code would need a schema the database does not have" >&2
printf '%s\n' "deploy: apply them, then deploy again (docs/VPS-OPERATIONS.md §2.3):" >&2
for command in "${commands[@]}"; do
    printf 'deploy:   %s\n' "${command}" >&2
done
exit 1
