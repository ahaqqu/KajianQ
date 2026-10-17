#!/usr/bin/env bash
# provision/vps/deploy/backup-provenance.sh — has kajianq-backup.service been
# exercised AS INSTALLED?
#
# Run ON the box, by provision/vps/deploy/deploy.sh over ssh, BEFORE the deploy
# touches anything. It reads only state that already exists there — the unit's
# own run record and the installed unit file's mtime — so a box that fails it is
# left on its previous revision, and the failure costs an ssh round trip instead
# of a shipped tree whose smoke and doctor were skipped.
#
# Usage: bash backup-provenance.sh [unit-file]
#
# The unit file path is an argument so the assertion can be executed against a
# fixture by tests/scripts/vps-hardening.test.mjs; the deploy passes nothing and
# gets the installed unit. The deploy pipes this file into `bash -s` rather than
# quoting it into the ssh command line, so what the test runs is byte-for-byte
# what the box runs.
#
# What NOT to assert, learned the hard way: `Result` alone is not the signal, and
# neither is the timer. The timer's `is-active` only says the schedule is armed —
# it stayed green through every failed run. `Result` alone is also unreliable
# because `systemctl reset-failed` clears it to `success` while, on systemd 257
# (the box), LEAVING `ExecMainStatus=1` behind — so a reset unit reports
# `Result=success` about a failed run, which is precisely the masking this check
# exists to prevent. Verified on both versions: systemd 261 clears both fields,
# 257 clears only `Result`.
#
# So the assertion is the pair: the last exit status must be 0 AND the last run
# must have happened AFTER this unit's current definition was installed. A unit
# whose last run predates its own file has, by definition, never been exercised
# in its current form — that is the "installed but never executed" state the
# backup spent its whole life in, and no field reports it directly.
#
# The install side keeps that mtime meaningful: apply.sh writes a config only
# when the installed file differs, so a re-apply over unchanged content does not
# re-stamp the unit and cannot mark an exercised unit as unproven.

set -euo pipefail

UNIT="kajianq-backup.service"
UNIT_FILE="${1:-/etc/systemd/system/${UNIT}}"

if [ ! -f "${UNIT_FILE}" ]; then
    echo "deploy: ${UNIT_FILE} is not installed — provision/vps/apply.sh has not placed it on this box" >&2
    exit 1
fi

# Both reads are guarded: a failing `systemctl show` would otherwise abort with its
# own exit status and no `deploy:` line saying what could not be read.
if ! status="$(systemctl show "${UNIT}" -p ExecMainStatus --value)"; then
    echo "deploy: could not read ${UNIT}'s exit status — systemctl show failed" >&2
    exit 1
fi
if ! exited="$(systemctl show "${UNIT}" -p ExecMainExitTimestamp --timestamp=unix --value)"; then
    echo "deploy: could not read ${UNIT}'s last-run timestamp — systemctl show failed" >&2
    exit 1
fi
installed="$(stat -c %Y "${UNIT_FILE}")"
exited="${exited#@}"

if [ -z "$exited" ]; then
    echo "deploy: kajianq-backup.service has never run — the encrypted backup is unproven" >&2
    echo "deploy: prove it now: sudo systemctl start kajianq-backup.service" >&2
    echo "deploy: if that answers 'Unit kajianq-backup.service not found', systemd has not loaded" >&2
    echo "deploy: the unit at all: sudo systemctl daemon-reload, and re-run provision/vps/apply.sh" >&2
    exit 1
fi
# A timestamp that is not a plain integer would make the comparison below an error, and
# a failing `[` inside an `if` condition is just false — the healthy line. That is the
# same fall-through-to-healthy shape the missing-unit-file guard closes, so it fails
# closed here too rather than reporting a health it never established.
case "$exited" in
    *[!0-9]*)
        echo "deploy: kajianq-backup.service reported a non-numeric last-run timestamp (${exited}) — cannot prove it ran as installed" >&2
        exit 1
        ;;
esac
# `-lt` parses its operands as intmax_t, so an all-digit run longer than it can hold errors
# the same way and reaches the same healthy line. Eleven digits already covers every
# plausible Unix second, so anything longer is refused rather than overflowed.
if [ "${#exited}" -gt 11 ]; then
    echo "deploy: kajianq-backup.service reported an out-of-range last-run timestamp (${exited}) — cannot prove it ran as installed" >&2
    exit 1
fi
if [ "$status" != "0" ]; then
    echo "deploy: kajianq-backup.service last run exited $status — the encrypted backup is failing" >&2
    echo "deploy: check: journalctl -u kajianq-backup.service -n 40" >&2
    exit 1
fi
if [ "$exited" -lt "$installed" ]; then
    echo "deploy: kajianq-backup.service last ran BEFORE its current definition was installed" >&2
    echo "deploy: this unit has never been exercised as installed — prove it: sudo systemctl start kajianq-backup.service" >&2
    exit 1
fi
echo "deploy: backup unit healthy (last run exited 0, after the current unit was installed)"
