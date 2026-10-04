# ADR-0044: The VPS serving path — Bun behind nginx, `pg` over TCP, and a single-shot cutover (supersedes ADR-0028's serving path)

## Decision

1. **The serving path is a plain Bun process behind nginx** — loopback-bound by
   default because the reverse proxy is the only public ingress, draining on
   SIGTERM, and configured from a root-owned env file, never `argv` or the unit
   text, which the process table and the journal would expose. The Cloudflare
   Worker entry, the Durable Object limiter and the R2 binding are deleted.
2. **Single-shot cutover, with no rollback runway.** Staging is verified first
   and prod cuts over in one step, with ADR-0038's snapshot criteria and restore
   drill strict. One box exists, labelled `staging`; production is deferred, not
   pending: a `prod` dispatch deploys the same box behind its approval gate. The
   `Staging` workflow, its `staging` environment and concurrency group, the
   `Deploy to VPS` input and the `prod` gate keep their names.
3. **The deployer lives in its own home, outside `apps/`** — one build → ship →
   restart → smoke implementation, called by the Staging workflow; provisioning
   stays under `provision/vps/`, and the box name and key come from environment
   secrets, never the repo.
4. **nginx replaces the bootstrap's Caddy, and the CDN proxy stays off.** The
   API reads the client address from a header nginx overwrites from
   `$remote_addr`; with the CDN proxy on, that address is a Cloudflare edge IP,
   so per-IP metering collapses silently — enabling it requires real-IP
   configuration first.
5. **The adapter speaks Postgres over TCP and is named for its dialect**: `pg`
   replaces the vendor's serverless transport, the provider is `postgres`, and the
   connection env is the vendor-free `DATABASE_URL`. Engine code still never
   imports a driver — one module adapts a `Pool` to the `SqlRunner` seam and
   reproduces the lazy tagged-template contract.
6. **One process, one timer, one deploy identity.** The limiter is the bounded
   in-memory backend with digest-named counters; the nightly reclamation is its
   own systemd timer; and a dedicated unprivileged account owns the deployed
   tree, holding exactly two granted systemctl commands behind a `visudo`
   parse. The name is fixed, not configurable, because a sudoers grant is
   per-username: the account, the grant and CI's `VPS_USER` are pinned by test,
   and the serving account is deliberately not given write access to that tree.
7. **The reviewer chain is paid and, for the current key set, same-vendor.**

## Why

The Alchemy-era path had app code owning hosting, a partly broken deploy (one workflow a destructive drop-and-recreate), and an e2e harness on a runtime production would never use — the criterion asks for the opposite.

- **Single-shot is a choice against a measured condition**, recorded so a future reader does not "fix" it; there is no live traffic to preserve, and cutting uptime tolerance relaxes no snapshot criterion.
- **nginx is fixed because the access-log format must be controlled field-by-field** — the IP-bearing access-log policy — and the code already assumes its semantics; the client-address header name is kept deliberately, because renaming it buys nothing.
- **The lazy-driver contract is documented because its failure is silent** — an eager driver runs `transaction` statements on separate pooled connections with no error, tearing `createSession`'s atomicity and `transaction([...])`'s.
- **One process justifies dropping Durable Objects; the guarantee moves, not the rule** — the limiter still holds one digest-named counter per key, which is the retention notice's claim.
- **The deploy grant is exactly the commands the deploy runs because the precondition it replaces had no executable existence** — the earlier arrangement rode a temporary blanket rule and broke the first deploy after its removal, and an unused grant is privilege widening that looks harmless.
- **Same-vendor review is accepted deliberately** — for the current key set the anti-self-review property is relaxed rather than drifted into.
- Rejected: keeping the Worker as a rollback — the window is gone, and the git history is the rollback.
- Rejected: the vendor's serverless driver against a self-hosted Postgres — it means a vendor's proxy mediating access to your own database.
- Rejected: the vendor's name as a provider/env alias — it would outlive its reason and mislead the next reader about where the data lives.
- Rejected: an in-process interval for the reclamation, and a container instead of systemd (deferred) — two failure modes must not share a process, the timer stays alive when the API is not, and the unit's hardening already buys the isolation.

## Consequences

- **The `RagStore` adapter is the tree's only `pg` importer**, exempted by the boundary gate explicitly as are the migrations CLI and the search probe, so the DB-client rule stays meaningful rather than relaxed wholesale.
- **The Staging Golden Set smoke is the post-cutover health signal**, and e2e boots the same Bun entry the deploy ships — the tested host is the served host.
- **CI's contract suite is self-contained** — a Postgres service container with the migrations applied, so it runs in every environment including fork PRs rather than against a shared secret-gated database; `tests/scripts/vps-hardening.test.mjs` is the gate on the grant, the fixed account name and the tree's ownership; the error reporter keeps its errors-only posture; and the deploy path, the units, the sudoers grant, the proxy site, the boot and cleanup entries and the driver adapter stay behind the `provision/vps/`, `apps/api/src/` and `packages/infra/src/` seams.
- **Revisit when** the API scales out beyond one process (the limiter needs a shared counter); a live-user base arrives (a rollback runway and a blue/green shape become a new decision); production is provisioned (a second host or a second tree behind `prod`); a second deploy target arrives, or a human operator deploys from a workstation (its key joins the same `authorized_keys` — supported, a separately-recorded choice); a vendor key becomes load-bearing in staging (promote it to a required env guard in the unit and the deploy's require-step); a second paid vendor key is provisioned (cross-vendor review returns by configuration alone); the deploy identity's trust is judged insufficient (a root-owned installer that fetches the artifact itself); or the box's ops burden proves disproportionate.
