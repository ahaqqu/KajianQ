# VPS baseline setup — record + reproducible bootstrap

What was actually done to the netcup VPS to take it from bare-metal to "serving
a valid-Lock HTTPS page", and the reproducible steps for setting up the **next**
VPS the same way. Written 2026-09-20 from the live session; every command was
run and verified on the real box.

Scope: **baseline only** — OS, access, firewall, one static hello-world page.
This is the layer under [`docs/VPS-HARDENING-RUNBOOK.md`](./VPS-HARDENING-RUNBOOK.md)
(privacy posture: log retention, backups, restore drills — **not yet applied**
to this box) and under ADR-0043
([`adr/0043-netcup-vps-hosting-gdpr-posture.md`](../adr/0043-netcup-vps-hosting-gdpr-posture.md),
the hosting decision itself). The app + database migration is GDPR-E (#181) and
has not started; the netcup DPA (#178) is still an owner action.

No hostnames, IPs, or credentials are committed here. The real values live in
the owner's netcup welcome mail and password manager; the runbook uses
placeholders. (The repo is public — the origin IP must not become part of its
history.)

## What was done on the box (the record)

| #   | Step                                             | Result                                                                                                                                     |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | SSH in as root with the netcup credentials       | Host key accepted, connected                                                                                                               |
| 2   | Identified the OS                                | **Debian 13 (trixie)** — kept as-is; not reinstalled to Ubuntu                                                                             |
| 3   | `apt update && apt full-upgrade -y`              | System current                                                                                                                             |
| 4   | Base tools installed                             | `ufw`, `unattended-upgrades`, `curl`, `git`, `sudo`                                                                                        |
| 5   | Admin user created, sudo enabled, key auth added | Non-root user (owner's name), `usermod -aG sudo`, laptop pubkey via `ssh-copy-id` from the **laptop**                                      |
| 6   | SSH hardened                                     | `PermitRootLogin no`, `PasswordAuthentication no` in `/etc/ssh/sshd_config`; verified from a **second** session before closing the old one |
| 7   | Firewall enabled                                 | `ufw`: default deny in / allow out; only 22, 80, 443 open (v4+v6)                                                                          |
| 8   | Caddy installed                                  | From **Debian's own repository** (no third-party repo needed on trixie)                                                                    |
| 9   | Static hello page + Caddy site                   | `/var/www/hello/index.html`, one server block in `/etc/caddy/Caddyfile`                                                                    |
| 10  | TLS certificate obtained                         | Let's Encrypt cert for the sslip.io hostname, automatic via Caddy; verified reachable from a browser with a valid padlock                  |

Journal access note from the session: non-root users can't read service logs by
default on Debian; either `sudo journalctl -u caddy -f` or
`sudo usermod -aG systemd-journal <user>` (applies on next login).

## Bootstrap runbook for a future VPS

For a fresh netcup (or similar) box, in order. Placeholders: `<IP>` = the
server's IPv4, `<user>` = the admin username, `<root-password>` / `<admin-password>`
from the provider mail / password manager.

### 0. Credentials

The provider's provisioning mail contains the IP, the root password, and (for
netcup) the hostname. The SCP (netcup: servercontrolpanel.de, a separate
account from the shop login) shows the OS image, and can reset the root
password if the mail is lost. Fresh installs can take 5–15 minutes to boot.

### 1. First login and OS check (as root)

```bash
ssh root@<IP>
cat /etc/os-release          # whatever it is, keep it — Debian/Ubuntu both work
apt update && apt full-upgrade -y
apt install -y ufw unattended-upgrades curl git sudo
```

### 2. Admin user (from the laptop)

Have a local key first (`ssh-keygen -t ed25519` if `ls ~/.ssh/id_ed25519.pub`
comes up empty), then:

```bash
# on the server, as root:
adduser <user>
usermod -aG sudo <user>

# on the laptop:
ssh-copy-id <user>@<IP>
ssh <user>@<IP>              # must log in WITHOUT <user>'s password
```

### 3. Lock down SSH (on the server, as `<user>`)

```bash
sudo nano /etc/ssh/sshd_config     # PermitRootLogin no, PasswordAuthentication no
sudo systemctl restart ssh
```

Verify from a second laptop terminal that `ssh <user>@<IP>` still works **before**
closing the current session — the open session is the safety rope.

### 4. Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose           # expect exactly 22, 80, 443 (v4+v6)
```

### 5. Web server + HTTPS without a domain

Caddy is the bootstrap choice: automatic Let's Encrypt issuance and renewal,
no certbot, ~4 lines of config. On Debian it comes from the official
repository:

```bash
sudo apt install -y caddy
sudo mkdir -p /var/www/hello
echo '<h1>hello from my VPS</h1>' | sudo tee /var/www/hello/index.html
```

**The no-domain trick:** `<dotted-IP>.sslip.io` (e.g. `62-83-35-220.sslip.io`
style — dots included) is a wildcard DNS name that resolves to that IP for
anyone, free, and Let's Encrypt issues real certificates for it. The cert is
then valid for the sslip.io name; when a real domain is bought later, the
migration is one Caddyfile line + one DNS A-record — nothing else moves.

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
<IP>.sslip.io {
    root * /var/www/hello
    file_server
}
EOF
sudo systemctl reload caddy
sudo journalctl -u caddy -f        # wait for "certificate obtained successfully"
```

Acceptance: from the laptop, `curl -I https://<IP>.sslip.io` → 200 with a valid
certificate, and the page opens in a browser with a padlock.

Caveats: sslip.io names share Let's Encrypt's rate-limit pool — occasional
"too many certificates" failures are transient, retry later. The trailing
"no OCSP stapling" log warning is harmless.

## Known deltas to reconcile before the app migration (#181)

1. **Proxy choice divergence.** The privacy-hardening runbook fixes
   **nginx** as the reverse proxy — chosen for field-by-field access-log
   control (ADR-0043 decision 4) and the codebase's 499 handling — while this
   bootstrap used **Caddy**. Both proxy fine, but they cannot share :80/:443.
   Before GDPR-E: either keep Caddy and port the log policy to it (amend the
   runbook + ADR-0043), or replace Caddy with the runbook's nginx (the runbook
   explicitly notes Caddy "buys nothing" for the privacy posture; its automatic
   TLS was the bootstrap value). One decision, made once, recorded in the same
   PR that starts the migration.
2. **Unapplied privacy layers.** The hardening runbook's pieces — log retention
   (14-day logrotate/journald caps), encrypted restic backups, restore drill,
   the unprivileged `kajianq` service account — are **not** on this box yet.
   They are prerequisites for the box touching personal data.
3. **DPA (#178) — done.** Concluded in the netcup CCP by the owner
   (2026-09-19); the Art. 30 record and DPIA-lite landed in #183. GDPR-E is
   unblocked from this side.
4. **Database.** The decision to move Postgres off Neon onto this VPS (Neon
   free tier exceeded) is recorded in ADR-0043's direction but the concrete
   pgvector + backup posture lands with GDPR-E.
5. **#181 scope.** GDPR-E's acceptance criteria now carry the four
   pre-migration gates this doc flags: the `PromptSpec.personalData`
   precondition, the on-host hardening application + restore drill, the
   About-page register flip, and the backup-timer/cron re-homing — plus the
   Caddy-vs-nginx proxy decision above, which must be made in the PR that
   starts the migration (issue #181, amended 2026-09-20).

## Related

- [`adr/0043-netcup-vps-hosting-gdpr-posture.md`](../adr/0043-netcup-vps-hosting-gdpr-posture.md) — the hosting decision this bootstrap executes the first (non-data) part of
- [`docs/VPS-HARDENING-RUNBOOK.md`](./VPS-HARDENING-RUNBOOK.md) — the privacy layer that comes next (retention, backups, restore drills)
- [`docs/GDPR-ARTICLE-30-RECORD.md`](./GDPR-ARTICLE-30-RECORD.md) — the Art. 30 record the TOMs map back to
