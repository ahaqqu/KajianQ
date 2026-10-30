#!/bin/sh
# provision/vps/backup/kajianq-backup-pending.sh — mark a backup run as started
# before the job body can run.
#
# Installed by the host configuration in ahaqqu/vps at /usr/local/sbin/kajianq-backup-pending
# and run from kajianq-backup.service's ExecStartPre, so a unit that starts
# writes it before the job body runs: a moved `bun`, an absent deployed bundle,
# or a broken ExecStart leaves this marker instead of the previous success. The
# deploy's provenance preflight refuses `status=pending`, the only durable
# evidence a run that starts and dies before the job writes anything can leave.
# A run systemd never starts — a `Requires=` dependency failing before any
# ExecStartPre — writes no marker and leaves the previous record in place; the
# gate header (`provision/vps/deploy/backup-provenance.sh`) states the same
# pre-spawn limit.
#
# The unit's EnvironmentFile is optional (`EnvironmentFile=-`) for this reason:
# systemd loads that file before the first ExecStartPre, and a missing required
# file fails the unit without spawning anything at all — the marker would be
# absent exactly when the missing env file is the failure, and the previous
# success would stay current. Optional, a missing file lets the run start: this
# marker lands and the job records `status=1` when it finds its configuration
# missing.
#
# The record is written atomically (a same-directory temp file renamed into
# place) at 0644 inside the root-owned record directory: the unprivileged
# deploy identity reads a whole record and cannot write one. The directory
# itself is provisioned by the host configuration and re-ensured by the job;
# this script does not create or widen it.
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
