# ADR-0044: The VPS serving path — Bun behind nginx, `pg` over TCP, and a single-shot cutover (supersedes ADR-0028's serving path)

## Decision

1. **The serving path is a plain Bun process behind nginx** — loopback-bound and draining on SIGTERM, with the Cloudflare Worker entry, the Durable Object limiter and the R2 binding deleted.
2. **Single-shot cutover, with no rollback runway.** Staging is verified first and
   prod then points at the VPS in one step: there is no live traffic to preserve,
   and ADR-0038's snapshot criteria and the restore drill stay strict. One box
   exists, labelled `staging`; production is deferred, not pending, so a `prod`
   dispatch deploys the same box behind its approval gate.
3. **The deployer lives in its own home, outside `apps/`** — one build → ship →
   restart → smoke implementation, called by the Staging workflow; provisioning
   stays under `provision/vps/`, and the box name and key come from environment
   secrets, never the repo.
4. **nginx replaces the bootstrap's Caddy, and the CDN proxy stays off.** nginx is
   fixed because the access-log format must be controlled field-by-field and the
   code already assumes its semantics; the API reads the client address from a
   header nginx overwrites from `$remote_addr`, a name kept deliberately because
   renaming it buys nothing. With the CDN proxy on, that address is a Cloudflare
   edge IP, so per-IP metering collapses silently — enabling it requires real-IP
   configuration first.
5. **The adapter speaks Postgres over TCP and is named for its dialect**: `pg`
   replaces the vendor's serverless transport, the provider is `postgres`, and the
   connection env is the vendor-free `DATABASE_URL`. Engine code still never
   imports a driver — one module adapts a `Pool` to the `SqlRunner` seam and
   reproduces the lazy tagged-template contract, so `transaction([...])` stays atomic.
6. **One process, one timer, one deploy identity.** The limiter is the bounded
   in-memory backend with digest-named counters, the retention notice's claim; the
   nightly reclamation is its own systemd timer, alive when the API is not; and a
   dedicated unprivileged account owning the deployed tree holds exactly two
   granted systemctl commands, installed only after a `visudo` parse.
7. **The reviewer chain is paid and, for the current key set, same-vendor** —
   accepted deliberately; a second paid vendor key restores cross-vendor review by
   configuration alone.

## Why

The Alchemy-era path had app code owning hosting, a partly broken deploy (one workflow a destructive drop-and-recreate), and an e2e harness on a runtime production would never use — the criterion asks for the opposite.

- **Single-shot is a choice against a measured condition**, recorded so a future reader does not "fix" it; cutting uptime tolerance relaxes no snapshot criterion.
- **The lazy-driver contract is documented because its failure is silent** — an eager driver runs `transaction` statements on separate pooled connections with no error, tearing `createSession`'s atomicity.
- **One process justifies dropping Durable Objects; the guarantee moves, not the rule** — the limiter still holds one digest-named counter per key.
- **The deploy grant is exactly the commands the deploy runs because the precondition it replaces had no executable existence** — the earlier arrangement rode a temporary blanket rule and broke the first deploy after its removal, and an unused grant is privilege widening that looks harmless.
- Rejected: keeping the Worker as a rollback — the window is gone, and the git history is the rollback.
- Rejected: the vendor's serverless driver against a self-hosted Postgres — it means a vendor's proxy mediating access to your own database.
- Rejected: the vendor's name as a provider/env alias — it would outlive its reason and mislead the next reader about where the data lives.
- Rejected: an in-process interval for the reclamation, and a container instead of systemd (deferred) — two failure modes must not share a process, and the unit's hardening already buys the isolation.

## Consequences

- **The `RagStore` adapter is the tree's only `pg` importer**, exempted by the boundary gate explicitly as are the migrations CLI and the search probe, so the DB-client rule stays meaningful rather than relaxed wholesale.
- **The Staging Golden Set smoke is the post-cutover health signal**, and e2e boots the same Bun entry the deploy ships — the tested host is the served host.
- **Revisit when** the API scales out beyond one process (the limiter needs a shared counter); a live-user base arrives (a rollback runway and a blue/green shape become a new decision); or the box's ops burden proves disproportionate.

## Where it lives

- `provision/vps/deploy/deploy.sh`, `.github/workflows/deploy-vps.yml`, `provision/vps/systemd/`, `provision/vps/sudoers/kajianq-deploy` and `provision/vps/nginx/` — the deploy path, the units, the grant and the proxy site; `.github/workflows/ci.yml` carries the self-contained contract suite (a Postgres service container with the migrations applied, so it runs in every environment including fork PRs).
- `apps/api/src/boot.ts`, `apps/api/src/cleanup.ts`, `packages/infra/src/rag-store-postgres-driver.ts` and `apps/api/src/lib/assets.ts` — the entries, the `pg` adapter and the asset reader, with the error reporter keeping its errors-only posture; `docs/VPS-OPERATIONS.md`, `docs/VPS-SETUP.md` and `docs/VPS-CUTOVER-RECORD.md` — manual, rebuild path and executed-cutover evidence.
