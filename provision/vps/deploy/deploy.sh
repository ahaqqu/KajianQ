#!/usr/bin/env bash
# provision/vps/deploy/deploy.sh — the VPS deploy path: build → ship → restart
# → smoke (#181, ADR-0044).
#
# This is the deployer's own home, deliberately OUTSIDE apps/ (issue #181's
# deployer-separation criterion): app code holds no hosting or deploy logic,
# provisioning stays under provision/vps/, CI gates stay in .github/workflows/,
# and the deploy path lives here with the workflow that calls it. A single
# decision, recorded in ADR-0044 decision 3.
#
# Usage:
#   provision/vps/deploy/deploy.sh --env /etc/kajianq/deploy.env
#   provision/vps/deploy/deploy.sh --env-file <path> [--dry-run] [--no-smoke]
#
# Wherever the box is named, it comes from an env file that is NOT in the
# repository (the repo is public — no real hostname may enter its history):
#
#   KAJIANQ_DEPLOY_HOST   the server (or a ~/.ssh/config alias)
#   KAJIANQ_DEPLOY_USER   the unprivileged login user
#   KAJIANQ_DEPLOY_ROOT   the deployed tree on the box (default /srv/kajianq)
#   KAJIANQ_PUBLIC_URL    the public base URL the smoke test hits
#
# The deploy is NOT zero-downtime and does not try to be (ADR-0044 decision 2):
# there are no live users, so a single-shot replace + restart is the recorded
# choice, not an omission. A reverse-proxy cache or a second port would be
# choreography with no beneficiary.
#
# Exit non-zero on the first failure: a half-shipped tree that reports success
# is worse than a failed deploy, because the operator would stop looking.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="/etc/kajianq/deploy.env"
DRY_RUN=0
RUN_SMOKE=1

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

for var in KAJIANQ_DEPLOY_HOST KAJIANQ_DEPLOY_USER; do
    # shellcheck disable=SC2154
    if [ -z "${!var:-}" ]; then
        echo "deploy: ${var} is empty in ${ENV_FILE}" >&2
        exit 1
    fi
done

DEPLOY_ROOT="${KAJIANQ_DEPLOY_ROOT:-/srv/kajianq}"
PUBLIC_URL="${KAJIANQ_PUBLIC_URL:-}"
SSH_TARGET="${KAJIANQ_DEPLOY_USER}@${KAJIANQ_DEPLOY_HOST}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/kajianq-deploy-XXXXXX")"
trap 'rm -rf "${STAGE}"' EXIT

# --- 1. build ---------------------------------------------------------------
# Two artifacts, both bundled for Bun so the box needs no node_modules:
#   api/index.js   the serving entry (apps/api/src/boot.ts)
#   api/cleanup.js the cron entry    (apps/api/src/cleanup.ts)
# `--target=bun` is what makes `pg` a plain dependency of the bundle rather
# than a runtime resolve against a tree the box does not have.
log "building web bundle + API entries"
run bun --version >/dev/null
run bun run --cwd "${REPO_DIR}" build:web
run bun build "${REPO_DIR}/apps/api/src/boot.ts" --target=bun \
    --outfile "${STAGE}/api/index.js"
run bun build "${REPO_DIR}/apps/api/src/cleanup.ts" --target=bun \
    --outfile "${STAGE}/api/cleanup.js"

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

# --- 2. ship ----------------------------------------------------------------
# rsync with --delete so a renamed asset does not linger on the box: the SPA is
# content-hashed, and a stale file is a stale file, not a rollback.
log "shipping to ${SSH_TARGET}:${DEPLOY_ROOT}"
run ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" \
    "mkdir -p '${DEPLOY_ROOT}/api' '${DEPLOY_ROOT}/web'"
run rsync -az --delete --chmod=D755,F644 \
    -e "ssh ${SSH_OPTS[*]}" \
    "${STAGE}/api/" "${SSH_TARGET}:${DEPLOY_ROOT}/api/"
run rsync -az --delete --chmod=D755,F644 \
    -e "ssh ${SSH_OPTS[*]}" \
    "${STAGE}/web/" "${SSH_TARGET}:${DEPLOY_ROOT}/web/"

# --- 3. restart -------------------------------------------------------------
# Restart the API, then run the cron unit once so the deploy proves it still
# executes end to end (its failure mode — a rotated env var, a missing key — is
# otherwise invisible until 03:17). The timer itself is not restarted: its
# schedule is unaffected by new code.
log "restarting kajianq-api.service"
run ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "sudo systemctl restart kajianq-api.service"
run ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" \
    "sudo systemctl is-active --quiet kajianq-api.service"

log "running the reclamation once (proves the cron entry executes)"
run ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "sudo systemctl start kajianq-cron.service"

# --- 4. smoke ---------------------------------------------------------------
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
fi

log "done. deployed and smoke-verified."
