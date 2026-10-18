#!/bin/sh
# provision/vps/backup/kajianq-backup-pending.sh — mark a backup run as started
# before the job body can run.
#
# Installed by provision/vps/apply.sh at /usr/local/sbin/kajianq-backup-pending
# and run from kajianq-backup.service's ExecStartPre, so it runs whether or not
# the job body does: a moved `bun`, an absent deployed bundle, or a broken
# ExecStart leaves this marker instead of the previous success. The deploy's
# provenance preflight refuses `status=pending`, which is the only durable
# evidence a run that died before the job wrote anything can leave.
#
# The unit's EnvironmentFile is optional (`EnvironmentFile=-`) for this reason:
# systemd loads that file before the first ExecStartPre, and a missing required
# file fails the unit without spawning anything at all — the marker would be
# absent exactly when the missing env file is the failure, and the previous
# success would stay current.
#
# The record is written atomically (a same-directory temp file renamed into
# place) at 0644 inside the root-owned record directory: the unprivileged
# deploy identity reads a whole record and cannot write one. The directory
# itself is provisioned by apply.sh and re-ensured by the job; this script does
# not create or widen it.
#
# Usage: kajianq-backup-pending.sh [record-file]

set -eu

RECORD="${1:-/var/lib/kajianq/backup-provenance}"
DIR="$(dirname -- "${RECORD}")"
TMP="${DIR}/.$(basename -- "${RECORD}").pending.$$"

# A failed write must not leave a temp file behind in the record directory.
cleanup() { rm -f -- "${TMP}"; }
trap cleanup EXIT HUP INT TERM

umask 022
printf 'status=pending\nstarted_at=%s\ncompleted_at=0\n' "$(date +%s)" >"${TMP}"
chmod 0644 "${TMP}"
mv -f -- "${TMP}" "${RECORD}"
