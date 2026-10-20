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
# box) as root: status, start and completion time, label and a best-effort
# revision. The directory is root-owned and 0755, the record is root-owned and
# 0644: the deploy identity can read the proof but cannot write or replace it,
# and only root can run the backup that produces it.
#
# The job writes a start marker before it touches the database and completes it
# on the way out, so an interrupted run (SIGTERM/SIGINT, OOM, the unit's start
# timeout) leaves `status=running` or `completed_at < started_at` — refused,
# rather than leaving an earlier success looking current.
#
# The unit writes its own marker before the job body runs (ExecStartPre, from
# /usr/local/sbin/kajianq-backup-pending): `status=pending`. It exists because a
# run that starts can die before the job writes anything at all — a moved `bun`,
# an absent deployed bundle, a broken ExecStart — and without it the record
# keeps the previous success and this check reads a failed run as current.
# `pending` is refused as its own case, below. A missing or unreadable
# backup.env is not that case: the unit's optional EnvironmentFile lets it
# start, and the job records status=1 itself. A run systemd never starts — a
# Requires= dependency failing before any ExecStartPre — leaves the previous
# record in place, so this marker guards the pre-body window, not the pre-spawn
# one.
#
# systemd's failed state is deliberately NOT read as a second signal: it
# describes the current boot. A reboot clears it (and `apply.sh` clears it with
# `reset-failed` on a re-install), so a unit that failed before a reboot reads
# as healthy afterwards — the opposite of the durability this check exists for.
#
# What the record proves is the pair: the last completed run exited 0, and it
# completed AFTER this unit's current definition was installed. A record older
# than the unit file means no run has recorded itself since that install — the
# "installed but not yet recorded" state this check exists for. It does not
# prove the unit's ExecStart ran: on a box whose installed bundle predates this
# writer, the first record comes from the checkout bootstrap, not the unit
# (docs/VPS-SETUP.md).
#
# The install side keeps that mtime meaningful: apply.sh writes a config only
# when the installed file differs, so a re-apply over unchanged content does not
# re-stamp the unit and cannot mark an exercised unit as unproven.

set -euo pipefail

UNIT="kajianq-backup.service"
UNIT_FILE="${1:-/etc/systemd/system/${UNIT}}"
RECORD_FILE="${2:-/var/lib/kajianq/backup-provenance}"

# Print each line as a deploy refusal and exit 1; keeps the matrix below readable.
refuse() {
    local line
    for line in "$@"; do
        printf 'deploy: %s\n' "${line}" >&2
    done
    exit 1
}

if [ ! -f "${UNIT_FILE}" ]; then
    refuse "${UNIT_FILE} is not installed — provision/vps/apply.sh has not placed it on this box"
fi

# Absent record: the backup has never completed on this box. The same refusal
# as before the record existed, because the proof is still missing.
if [ ! -f "${RECORD_FILE}" ]; then
    refuse \
        "${UNIT} has never run — the encrypted backup is unproven" \
        "a human with root must prove it: sudo systemctl start ${UNIT}" \
        "if that answers 'Unit ${UNIT} not found', systemd has not loaded" \
        "the unit at all: sudo systemctl daemon-reload, and re-run provision/vps/apply.sh" \
        "if the installed bundle predates the writer, bootstrap from the checkout: docs/VPS-SETUP.md §8"
fi

# One read, then parse the buffer. Reading the file once per field would pair a
# status from one write with a timestamp from another when the job renames a new
# record between the reads.
if ! record="$(cat -- "${RECORD_FILE}")"; then
    refuse "could not read ${RECORD_FILE} — cannot prove ${UNIT} ran as installed"
fi

status=""
started=""
completed=""
while IFS= read -r line || [ -n "${line}" ]; do
    case "${line}" in
        status=*) status="${line#status=}" ;;
        started_at=*) started="${line#started_at=}" ;;
        completed_at=*) completed="${line#completed_at=}" ;;
    esac
done <<< "${record}"

# An interrupted run: the start marker was written and never completed. This is
# the SIGTERM / OOM / systemd-timeout state; without it a killed run would leave
# the previous success in place and the deploy would pass.
interrupted() {
    refuse \
        "${UNIT} started a run but has not recorded its completion — the backup is unproven until a run completes" \
        "check: journalctl -u ${UNIT} -n 40" \
        "prove it as root: sudo systemctl start ${UNIT}"
}

if [ "${status}" = "running" ]; then
    interrupted
fi

# A run that started and never reached the job body: the unit's own marker is
# still in place, so nothing in the job ever overwrote it (a moved bun, an
# absent deployed bundle, a broken ExecStart). The record carries no exit status
# here, so it is its own refusal rather than the non-numeric-status one below.
if [ "${status}" = "pending" ]; then
    refuse \
        "${UNIT} started a run that never reached the backup job — the encrypted backup is unproven" \
        "check: systemctl status ${UNIT}; journalctl -u ${UNIT} -n 40" \
        "prove it as root: sudo systemctl start ${UNIT}"
fi

# Every value is bounded: a non-numeric or oversized timestamp would make `-lt`
# error, and a failing `[` inside `if` is just false — the healthy line. Eleven
# digits already covers every plausible Unix second.
if [ -z "${started}" ]; then
    refuse "${RECORD_FILE} does not record when the last run started — cannot prove ${UNIT} ran as installed"
fi
case "${started}" in
    *[!0-9]*)
        refuse "${UNIT} recorded a non-numeric start timestamp (${started}) — cannot prove it ran as installed"
        ;;
esac
if [ "${#started}" -gt 11 ]; then
    refuse "${UNIT} recorded an out-of-range start timestamp (${started}) — cannot prove it ran as installed"
fi

if [ -z "${completed}" ]; then
    refuse "${RECORD_FILE} does not record when the last run completed — cannot prove ${UNIT} ran as installed"
fi
case "${completed}" in
    *[!0-9]*)
        refuse "${UNIT} recorded a non-numeric completion timestamp (${completed}) — cannot prove it ran as installed"
        ;;
esac
if [ "${#completed}" -gt 11 ]; then
    refuse "${UNIT} recorded an out-of-range completion timestamp (${completed}) — cannot prove it ran as installed"
fi

if [ "${completed}" -lt "${started}" ]; then
    interrupted
fi

if [ -z "${status}" ]; then
    refuse "${RECORD_FILE} does not record an exit status — cannot prove ${UNIT} ran as installed"
fi
case "${status}" in
    *[!0-9]*)
        refuse "${UNIT} recorded a non-numeric exit status (${status}) — cannot prove it ran as installed"
        ;;
esac

# A failure recorded by the job is the last completed run, so it refuses the
# deploy even when an earlier run succeeded. The journal is where the cause is.
if [ "${status}" != "0" ]; then
    refuse \
        "${UNIT} last run exited ${status} — the encrypted backup is failing" \
        "check: journalctl -u ${UNIT} -n 40"
fi

if ! installed="$(stat -c %Y "${UNIT_FILE}")"; then
    refuse "could not read ${UNIT_FILE}'s install time — cannot prove ${UNIT} ran as installed"
fi
case "${installed}" in
    *[!0-9]*)
        refuse "could not parse ${UNIT_FILE}'s install time (${installed}) — cannot prove ${UNIT} ran as installed"
        ;;
esac
if [ "${#installed}" -gt 11 ]; then
    refuse "could not parse ${UNIT_FILE}'s install time (${installed}) — cannot prove ${UNIT} ran as installed"
fi
if [ "${completed}" -lt "${installed}" ]; then
    refuse \
        "${UNIT} last completed BEFORE its current definition was installed" \
        "this unit has never been exercised as installed — prove it as root: sudo systemctl start ${UNIT}" \
        "if the installed bundle predates the writer, bootstrap from the checkout: docs/VPS-SETUP.md §8"
fi
echo "deploy: backup unit healthy (last recorded run exited 0, after the current unit was installed)"
