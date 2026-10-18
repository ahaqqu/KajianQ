#!/usr/bin/env bash
# provision/vps/deploy/backup-provenance.sh — has kajianq-backup.service been
# exercised AS INSTALLED?
#
# Run ON the box, by provision/vps/deploy/deploy.sh over ssh, BEFORE the deploy
# touches anything. It reads only durable state that already exists there — the
# backup job's own provenance record and the installed unit file's mtime — so a
# box that fails it is left on its previous revision, and the failure costs an
# ssh round trip instead of a shipped tree whose smoke and doctor were skipped.
#
# Usage: bash backup-provenance.sh [unit-file] [record-file]
#
# Both paths are arguments so the assertion can be executed against a fixture by
# tests/scripts/vps-hardening.test.mjs; the deploy passes nothing and gets the
# installed unit and the installed record. The deploy pipes this file into
# `bash -s` rather than quoting it into the ssh command line, so what the test
# runs is byte-for-byte what the box runs.
#
# The record is the authority, never systemd's runtime state. `ExecMainStatus`
# and `ExecMainExitTimestamp` describe the CURRENT boot: a reboot clears them,
# so a unit that ran successfully hours earlier reads as exit status 0 with an
# empty timestamp — indistinguishable from one that has never run. The backup
# job therefore writes its own record (/var/lib/kajianq/backup-provenance on the
# box) on every completed run of the unit, as root. The directory is root-owned
# and 0755, the record is root-owned and 0644: the deploy identity can read the
# proof but cannot write or replace it, and only root can run the backup that
# produces it.
#
# What the record proves is the pair: the last completed run exited 0, and it
# completed AFTER this unit's current definition was installed. A record older
# than the unit file means the unit has never been exercised in its current
# form — the "installed but never executed" state this check exists for.
#
# The install side keeps that mtime meaningful: apply.sh writes a config only
# when the installed file differs, so a re-apply over unchanged content does not
# re-stamp the unit and cannot mark an exercised unit as unproven.

set -euo pipefail

UNIT="kajianq-backup.service"
UNIT_FILE="${1:-/etc/systemd/system/${UNIT}}"
RECORD_FILE="${2:-/var/lib/kajianq/backup-provenance}"

if [ ! -f "${UNIT_FILE}" ]; then
    echo "deploy: ${UNIT_FILE} is not installed — provision/vps/apply.sh has not placed it on this box" >&2
    exit 1
fi

# Absent record: the backup has never completed on this box. The same refusal
# as before the record existed, because the proof is still missing.
if [ ! -f "${RECORD_FILE}" ]; then
    echo "deploy: ${UNIT} has never run — the encrypted backup is unproven" >&2
    echo "deploy: a human with root must prove it: sudo systemctl start ${UNIT}" >&2
    echo "deploy: if that answers 'Unit ${UNIT} not found', systemd has not loaded" >&2
    echo "deploy: the unit at all: sudo systemctl daemon-reload, and re-run provision/vps/apply.sh" >&2
    exit 1
fi

# Every read is guarded: a failing `sed` or `stat` would otherwise abort with its
# own exit status and no `deploy:` line saying what could not be read.
record_field() {
    sed -n "s/^$1=//p" "${RECORD_FILE}"
}
if ! status="$(record_field status)"; then
    echo "deploy: could not read ${RECORD_FILE} — cannot prove ${UNIT} ran as installed" >&2
    exit 1
fi
if ! completed="$(record_field completed_at)"; then
    echo "deploy: could not read ${RECORD_FILE} — cannot prove ${UNIT} ran as installed" >&2
    exit 1
fi
if ! installed="$(stat -c %Y "${UNIT_FILE}")"; then
    echo "deploy: could not read ${UNIT_FILE}'s install time — cannot prove ${UNIT} ran as installed" >&2
    exit 1
fi

# An empty or non-numeric status cannot be reported as an exit code or matched
# against success, and inside `case` a bad value is the healthy line. Fail closed
# on a record that does not name a status at all.
if [ -z "${status}" ]; then
    echo "deploy: ${RECORD_FILE} does not record an exit status — cannot prove ${UNIT} ran as installed" >&2
    exit 1
fi
case "${status}" in
    *[!0-9]*)
        echo "deploy: ${UNIT} recorded a non-numeric exit status (${status}) — cannot prove it ran as installed" >&2
        exit 1
        ;;
esac
# A completed_at that is not a plain integer has the same fail-open shape as a
# garbled status; the length bound keeps `-lt` from erroring on a number larger
# than intmax_t, which inside `if` would read as the healthy line. Eleven digits
# already covers every plausible Unix second.
if [ -z "${completed}" ]; then
    echo "deploy: ${RECORD_FILE} does not record when the last run completed — cannot prove ${UNIT} ran as installed" >&2
    exit 1
fi
case "${completed}" in
    *[!0-9]*)
        echo "deploy: ${UNIT} recorded a non-numeric completion timestamp (${completed}) — cannot prove it ran as installed" >&2
        exit 1
        ;;
esac
if [ "${#completed}" -gt 11 ]; then
    echo "deploy: ${UNIT} recorded an out-of-range completion timestamp (${completed}) — cannot prove it ran as installed" >&2
    exit 1
fi

# A failure recorded by the job is the last completed run, so it refuses the
# deploy even when an earlier run succeeded. The journal is where the cause is.
if [ "${status}" != "0" ]; then
    echo "deploy: ${UNIT} last run exited ${status} — the encrypted backup is failing" >&2
    echo "deploy: check: journalctl -u ${UNIT} -n 40" >&2
    exit 1
fi
if [ "${completed}" -lt "${installed}" ]; then
    echo "deploy: ${UNIT} last completed BEFORE its current definition was installed" >&2
    echo "deploy: this unit has never been exercised as installed — prove it as root: sudo systemctl start ${UNIT}" >&2
    exit 1
fi
echo "deploy: backup unit healthy (last recorded run exited 0, after the current unit was installed)"
