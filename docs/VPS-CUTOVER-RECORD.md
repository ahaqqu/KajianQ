# VPS cutover record — the executed log of GDPR-E's on-host half

The executed companion to [`docs/VPS-CUTOVER-RUNBOOK.md`](./VPS-CUTOVER-RUNBOOK.md):
every command actually run on the box (or the deploying machine) while the
migration was carried out, with the decisive output and the evidence row it
maps to. Written live, in execution order — not a plan. Where a step failed and
was retried, the failure is recorded too.

Sanitization: the repository is public, so no real hostname, IP address,
credential, or connection string appears here — placeholders only, same rule as
[`docs/VPS-BASELINE-SETUP.md`](./VPS-BASELINE-SETUP.md). Real values live in the
owner's password manager and in `/etc/kajianq/*.env`, mode 0600, on the box.

ADR: [`adr/0044-vps-serving-path-cutover.md`](../adr/0044-vps-serving-path-cutover.md).
Issue: #181. The PR-level review loop and merge are recorded on PR #189.

## Session opened — 2026-09-20

Access: the owner granted SSH key access to the baseline box as the admin user
(`<user>@<IP>`; the machine already held the key). Sudo was made passwordless
for this session at the owner's action (`/etc/sudoers.d/<user>-nopasswd`);
removing it again is a closing step of this record.

## Step 0 survey — the box as found (before any change)

Commands run via `ssh <user>@<IP>`; all output verified against
[`docs/VPS-BASELINE-SETUP.md`](./VPS-BASELINE-SETUP.md)'s record — the box is
exactly where the baseline left it:

| Check           | Found                                                              |
| --------------- | ------------------------------------------------------------------ |
| OS              | Debian 13 (trixie), up 1 day, load ~0                              |
| Caddy           | active, serving the bootstrap site (`<IP>.sslip.io` → static page) |
| nginx           | not installed                                                      |
| Postgres        | not installed                                                      |
| Bun             | not installed                                                      |
| kajianq user    | absent                                                             |
| `/srv/kajianq`  | absent                                                             |
| `/etc/kajianq`  | absent                                                             |
| kajianq units   | none in `/etc/systemd/system/`                                     |
| restic          | not installed; `/etc/logrotate.d/` holds only package defaults     |
| Listening ports | 22 (ssh), 80/443 (caddy), 127.0.0.1:2019 (caddy admin)             |
| ufw             | active, default deny in — exactly 22/80/443 allowed (v4+v6)        |
| Disk / memory   | 125 GB volume, 1.2 GB used; 3.8 GiB RAM, 3.1 GiB free              |

Conclusion: the runbook's step 0 applies in full — nothing above the baseline
layer exists on the box yet.

## Step 0 execution — box prep (nginx replaces Caddy, Postgres, hardening, units)

In progress — appended as executed.
