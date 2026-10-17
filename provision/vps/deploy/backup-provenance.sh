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

# A unit systemd does not know about (no `daemon-reload` since the apply) is its
# own broken state, and `systemctl show` exits non-zero on it: name it here, so
# the log distinguishes "not loaded" from "loaded but never run".
if ! status="$(systemctl show "${UNIT}" -p ExecMainStatus --value)"; then
    echo "deploy: systemd does not know ${UNIT} — is the unit installed and loaded (systemctl daemon-reload)?" >&2
    exit 1
fi
exited="$(systemctl show "${UNIT}" -p ExecMainExitTimestamp --timestamp=unix --value)"
installed="$(stat -c %Y "${UNIT_FILE}")"
exited="${exited#@}"

if [ -z "$exited" ]; then
    echo "deploy: kajianq-backup.service has never run — the encrypted backup is unproven" >&2
    echo "deploy: prove it now: sudo systemctl start kajianq-backup.service" >&2
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
