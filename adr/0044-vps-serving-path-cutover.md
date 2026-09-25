# ADR-0044: The VPS serving path — self-hosted Bun + Postgres, the deployer's own home, and a single-shot cutover

## Status

Accepted (2026-09-20). Supersedes **ADR-0028's serving path** (the Alchemy-owned
Cloudflare Worker lifecycle): the Worker, the Durable Object rate limiter, the
R2 binding, and `alchemy dev` as the local/e2e runtime are removed. It does not
supersede ADR-0028's _idea_ that the topology is described as code and that
wrangler stays retired — the topology is now the VPS, described by
`provision/vps/` and shipped by `provision/vps/deploy/deploy.sh`.

It records the decisions issue #181 (GDPR-E) requires be written down rather
than left as code placement, and it is the ADR the migration's end state cites,
alongside ADR-0043 (hosting choice, register, retention values). It does **not**
relitigate ADR-0008 (the `RagStore` seam), ADR-0009/ADR-0022 (vendor config),
ADR-0021 (the pipeline runner), ADR-0017 (anonymous sessions), ADR-0038
(snapshot discipline), or ADR-0041 (metering the `/v1` surface only).

Nothing here claims the box is serving today: the repo-side change is complete
and CI-green, and the on-host application + cutover is the owner's step, now
**executed** and recorded — with its evidence and the #181 acceptance-criteria
checklist — in `docs/VPS-CUTOVER-RECORD.md`. A fresh box follows
`docs/SELF-HOSTING-GUIDE.md`.

## Context

- **The migration's storage half was invisible in the adapter's shape.**
  `RagStore`'s only adapter was named for its host (`rag-store-neon.ts`, provider
  `"neon"`) and reached Postgres through a hosting vendor's HTTP/WebSocket
  transport. Moving to a self-hosted server therefore looked like a
  storage-engine change, and the transport's semantics (a _lazy_ tagged-template
  result that `transaction([...])` batches) were load-bearing and undocumented at
  the seam.
- **`apps/api` owned hosting.** `apps/api/alchemy.run.ts` declared the whole
  Cloudflare topology, `apps/api/package.json` carried six `alchemy:*` scripts
  and a preflight, and `apps/api/src/index.ts` was the Worker's default-export
  handler with a cron `scheduled` and a `RateLimiterDo` re-export. Issue #181's
  deployer-separation criterion asks for exactly the opposite: app code carries
  no hosting/deploy logic.
- **The Cloudflare-era deploy path was partly broken and partly dangerous.**
  `deploy.yml`/`provision.yml` deployed through Alchemy with the five worker
  secrets passed as env; `neon-schema-reapply.yml` was a **destructive**,
  manually-triggered drop-and-recreate of the engine schema against the shared
  database — a workflow whose only remaining reason to exist was fix-forward on
  a schema the migration makes local.
- **The e2e harness ran on a runtime production would never use.** `bun run e2e`
  booted `alchemy dev` (local workerd) via `playwright.config.ts`. With the
  Cloudflare path gone there is no workerd in the tree, so the harness had to
  move with the serving host or the suites would test a shim.
- **There are no live users** (issue #181, amended 2026-09-20). Downtime is not
  a concern, so the migration is a single-shot cutover: no rollback runway, no
  warm second deployment, no traffic-shift choreography.
- **The proxy decision was made by the manager before this PR**: nginx replaces
  the bootstrap's Caddy (ADR-0043 decision 4 and the hardening runbook already
  fix nginx, and the two cannot share :80/:443). The bootstrap's Caddyfile is
  retired on the box; the runbook gains the teardown step.

## Decision

1. **The serving path is a plain Bun process behind nginx.**
   `apps/api/src/boot.ts` boots the unchanged Hono app (`createApi`) with
   `Bun.serve`, binding **loopback** by default (the reverse proxy is the only
   public ingress), and drains on SIGTERM so an in-flight SSE answer is not cut
   mid-answer. `provision/vps/systemd/kajianq-api.service` runs it unprivileged,
   with its environment in a root-owned `/etc/kajianq/api.env` — never argv,
   never the unit file. The Cloudflare Worker entry, the `RateLimiterDo` class,
   the R2 binding, and `cf-types.ts` are deleted: an orphaned deploy path is
   what the criterion forbids, and the ADR-0028 stack file had no role left.

2. **Single-shot cutover; zero-downtime choreography is explicitly out of
   scope.** Staging is deployed and verified first (engineering order), then
   prod points at the VPS in one step. There is no rollback runway, no warm
   second deployment, and no traffic-shift step, because there is no live
   traffic to preserve. The hard half of #181 is **data integrity**, which stays
   strict: the pre/post snapshot criteria (ADR-0038) and the restore drill are
   unchanged. The old path may be decommissioned as soon as the post-cutover
   snapshot verifies — **decommissioning itself is owner-approved in review**,
   per the issue.

3. **The deployer lives in its own home, outside `apps/`.** The deploy path
   (build → ship → restart → smoke) is `provision/vps/deploy/deploy.sh`, with
   the CI trigger in `.github/workflows/deploy-vps.yml`; the Staging workflow
   calls that reusable workflow rather than re-implementing the steps, so there
   is one implementation. Provisioning stays under `provision/vps/` and CI gates
   stay in `.github/workflows/`. The script builds two Bun-target bundles
   (`boot.ts`, `cleanup.ts`) so the box needs no `node_modules`, rsyncs with
   `--delete` (a stale content-hashed asset is not a rollback), restarts the
   API, runs the cron unit once (so a rotated env var fails the deploy rather
   than 03:17), and smokes the **public** URL through the proxy and TLS. The box
   name and key come from an env file / environment secrets, never the repo — it
   is public, and the origin must not enter its history.

4. **nginx, not Caddy, as the reverse proxy.** This executes the one decision the
   bootstrap deferred (ADR-0043 decision 4): nginx is fixed because the
   access-log format must be controlled field-by-field (the 14-day IP-bearing
   policy), and the codebase already assumes nginx semantics (the 499
   client-closed handling in `apps/api/src/lib/errors.ts`). The bootstrap's Caddy
   site is torn down on the box as the runbook's first step, so :80/:443 have one
   owner. The API reads the client address from `CF-Connecting-IP`, which nginx
   overwrites unconditionally from `$remote_addr` — the header name is kept
   deliberately: renaming it would be churn with no behavioral gain, and the
   value is proxy-established either way. **The Cloudflare CDN proxy stays OFF
   at cutover** (DNS-only): with the proxy on, nginx's `$remote_addr` is a
   Cloudflare edge IP, so every visitor behind one edge POP would share a single
   rate-limit budget — per-IP metering (ADR-0041) would collapse without any
   error to observe. Enabling the proxy later is a recorded decision that must
   first ship `ngx_http_realip_module` config (`set_real_ip_from` for
   Cloudflare's published IP ranges + `real_ip_header CF-Connecting-IP`) so
   `$remote_addr` becomes the real client again — the nginx conf carries that
   requirement in its own comment, and SPECS §3.2's "optionally the CDN proxy"
   is read subject to it.

5. **The database adapter speaks Postgres over TCP, named for its dialect.**
   `pg` (node-postgres) replaces the hosting vendor's serverless transport; the
   adapter and its modules are renamed `rag-store-postgres*`, the factory
   provider is `"postgres"`, and the connection env is the vendor-free
   `DATABASE_URL` (`NEON_DATABASE_URL` is removed outright — a back-compat alias
   would keep a vendor in the configuration of a self-hosted store, which is
   exactly what the move is undoing). ADR-0008 is intact: engine code still
   never imports a driver; `packages/infra/src/rag-store-postgres-driver.ts` is
   the one place `pg` is imported, and it adapts a `Pool` to the existing
   structural `SqlRunner` seam. It reproduces the **lazy** tagged-template
   contract the adapter was written against (`DeferredQuery`), so
   `transaction([...])` still runs its statements on one connection inside
   `BEGIN … COMMIT` — with the eager node-postgres driver they would otherwise
   run on separate pooled connections outside any transaction, silently losing
   `createSession`'s atomicity. That laziness is now documented at the seam,
   because it is load-bearing and was previously an accident of the vendor's
   driver.

6. **Host-specific bindings are gone, and the rate limiter is process-wide.**
   `AppBindings` replaces `WorkerBindings` and drops `BUCKET` and `RATE_LIMITER`
   (both lost their producers). The limiter is the package's bounded in-memory
   backend: the API is **one** process, so per-process and global-for-the-
   deployment are the same set — the cross-isolate property Durable Objects
   existed to provide has no meaning with one isolate. The counter is still
   named by a digest (`fnv1aHex`), so the retention notice's "kept in memory and
   named by a digest" claim stays true; the middleware now applies that digest
   itself. Sentry moves to `@sentry/bun` (same errors-only posture), and the
   static-asset handle becomes a disk reader (`lib/assets.ts`) whose cache/404
   policy still comes from `@app/hardening`'s `serveAssets`, so the two hosts
   cannot disagree.

7. **The nightly session reclamation is a systemd timer, not an in-process
   interval.** `cleanupExpiredSessions` (ADR-0017) ran as a Worker cron at
   `17 3 * * *`; it now runs as `provision/vps/systemd/kajianq-cron.{service,timer}`
   at the same slot, invoking the dedicated entry `apps/api/src/cleanup.ts`. A
   separate process keeps the schedule independently observable
   (`systemctl list-timers`) and reclaims even when the serving process is
   unhealthy — the two have different failure modes and should not share one.

8. **CI's contract suite became self-contained.** The `neon:contract` job (the
   `@neondatabase/serverless`-gated suite against a shared external database) is
   replaced by `postgres:contract`: a `pgvector/pgvector:pg18` **service
   container** — the same image the restore drill uses and the major the box is
   provisioned with — with the three migration sets applied first. The suite now
   runs in every environment including fork PRs, with no shared external state to
   race, and the default gate still runs it nowhere (it self-skips without
   `DATABASE_URL`).

## Rationale

- **The deployer being separate is what makes "app code" mean something.** With
  `alchemy.run.ts` inside `apps/api`, every hosting decision was an app-file
  edit; the criterion's value is that a fork can change or replace the deploy
  path without touching a line of application code. The reusable-workflow split
  matters for the same reason at the CI layer: two workflows deploying by two
  implementations would drift on the first change.
- **Recording the single-shot decision prevents a future reader from
  "fixing" it.** The absence of a rollback runway reads as an oversight unless
  the ADR says it is a choice made against a measured condition (no live users).
  It also keeps the strict half visible: cutting uptime tolerance does not relax
  a single snapshot or restore criterion.
- **The lazy-driver contract is documented because its failure is silent.** An
  eager driver would make `transaction` non-atomic with no error — a torn
  `createSession` is a user row with no session, which the FK cascade then
  cannot clean up. Writing it at the seam is what stops a future adapter author
  from "simplifying" `DeferredQuery` away.
- **One process justifies dropping Durable Objects, but the guarantee is what
  moves, not the rule.** The limiter still exists, still holds one counter per
  key, still hashed; only cross-process counting is gone, and it had no meaning
  here. The revisit trigger makes the boundary explicit rather than pretending
  the in-memory backend scales.
- **A container beats a shared secret-gated database for the contract suite.**
  A shared environment is exactly the thing the migration removes; a service
  container makes the suite hermetic and fork-runnable, and pinning the image to
  `pgvector:pg18` keeps it matching the box.

## Alternatives considered

- **Keep the Cloudflare Worker deployed as the rollback until decommissioning.**
  Rejected as the shape to _build for_: ADR-0043 retained it while the rollback
  window mattered, but the issue's amendment removed that window (no live users,
  single-shot cutover), and keeping it would leave an app-side Worker entry plus
  a deploy path the criterion forbids. The `git` history is the rollback.
- **Keep the vendor's serverless driver against a self-hosted Postgres.** It
  can reach a plain server over a WebSocket proxy, but that means running the
  vendor's proxy on the box — a hosting vendor's software mediating access to
  _your own_ database, kept only to avoid a driver swap. Rejected.
- **Keep the `neon` provider name and env var as an alias.** Rejected: the
  point is that configuration and naming stop naming a vendor. A one-line
  back-compat shim would outlive its reason and mislead the next reader about
  where the data lives.
- **A second snapshot tool that encrypts corpus dumps.** Rejected, and ADR-0043
  decision 5 already says why: `db:snapshot` is the corpus durability layer
  (ADR-0038), and the encrypted-at-rest path is the GDPR-D backup tooling
  (`provision/vps/backup/`, restic client-side encryption). The CLI instead
  **computes** whether an archive carries personal data and refuses to write one
  to an unasserted target without an explicit acknowledgement, so the exposure
  ADR-0043 decision 5 records stays visible instead of being papered over by a
  second tool.
- **An in-process interval for the nightly reclamation.** Rejected: two jobs
  with different failure modes sharing a process means a wedged API stops the
  reclamation too, and a timer is independently observable.
- **A container (Docker) instead of systemd for the API.** Deferred, not
  rejected: the hardening runbook is systemd-shaped (an unprivileged account,
  `EnvironmentFile`, journald), and adding a container runtime buys isolation
  the unit's own hardening already provides at a smaller operational cost.

## Consequences

- **The e2e harness tests the production runtime.** `playwright.config.ts` boots
  `apps/api/src/boot.ts` with `KAJIANQ_WEB_ROOT` at the fresh web build; the 33
  BDD scenarios run green against it. This is a fidelity _gain_ (the served host
  is the tested host) and a fidelity _loss_ in one respect: the workerd runtime
  is no longer exercised at all, which is fine because it is no longer a target.
- **The rate limiter's guarantee narrows to one process.** A scale-out to
  several API processes would need a shared counter (a store-backed limiter, or
  sticky routing) — recorded as the revisit trigger, not built.
- **The `RagStore` adapter is now the tree's only `pg` importer**, and the
  boundary gate exempts that module (and its unit test) explicitly, so the
  DB-client rule stays meaningful rather than being relaxed wholesale. The
  migrations CLI and the search probe also import `pg` and remain exempt as the
  scripts that own migrations/probes against a real database.
- **A latent fail-open was fixed on the way, in code the hardening ticket
  shipped.** `provision/vps/apply.sh` validated the env file's mode with bash's
  `0#` base prefix, which rejects `stat`'s printed octal (`600`, not `0600`) with
  "invalid number"; inside `[ ]` that error is a false condition, so a 644 file
  was accepted — the exact fail-open the check exists to prevent. Both it and the
  new deploy script now parse base 8 explicitly.
- **The staging environment is the VPS, and its post-cutover health signal is
  the Golden Set smoke.** That smoke was red on the Cloudflare free-plan CPU wall
  before the move; it now runs against the VPS and must be green (issue #181).
- **ADR-0043's implementation-status notes are amended, not rewritten.** The
  hosting decision, register, and retention values stand; the register row
  statuses move to the post-migration state, and the Art. 30 record's
  "implemented as code, not yet applied" rows stay as they are until the owner
  reports the on-host evidence. Keeping those two apart is the honesty rule:
  status flips with the code, evidence flips with the host.

## Implementation map

- `apps/api/src/boot.ts`, `apps/api/src/cleanup.ts`, `apps/api/src/lib/server.ts`,
  `apps/api/src/lib/assets.ts` — the serving + cron entries and their host glue.
- `provision/vps/systemd/kajianq-cron.{service,timer}` — the nightly schedule;
  `provision/vps/deploy/deploy.sh` + `.github/workflows/deploy-vps.yml` — the
  deploy path.
- `packages/infra/src/rag-store-postgres*-*` — the adapter, its driver adapter,
  and its error classifier; `scripts/boundary-rules.json` — the `pg` exemption.
- `packages/rate/` — the Durable Object backend removed, the process-wide
  limiter stated.
- `.github/workflows/ci.yml` (`postgres:contract`), `staging.yml`,
  `e2e.yml`, `playwright.config.ts` — the harness and CI moves.
- `docs/VPS-CUTOVER-RECORD.md` — the executed cutover, its evidence, and the
  #181 acceptance-criteria checklist (the runbook it was executed from is
  retired; `docs/SELF-HOSTING-GUIDE.md` now carries the fork-and-run path);
  `docs/VPS-HARDENING-RUNBOOK.md` — gains the Caddy teardown step.
- `adr/0043-…` amendment, `SPECS.md` §3/§5/§7/§8, `docs/ARCHITECTURE.md`
  §8/§15/§16 — the decisions and the spec kept true in the same PR.

## Revisit triggers

- The API scales out to more than one process → the rate limiter needs a shared
  counter, and this ADR's "one process" premise ends.
- A live-user base arrives → the single-shot cutover's premise ends; a rollback
  runway and a blue/green or traffic-shift shape become a new ADR.
- The box's ops burden (backups, upgrades, restore drills) proves
  disproportionate → revisit ADR-0043's "managed EU Postgres" alternative.
- A second deploy target (a container platform, a second region) → the deploy
  script grows a target argument, or a new ADR names the fork.
- Sentry or a vendor key becomes load-bearing in staging → promote `SENTRY_DSN`
  and the provider keys to required env guards in the systemd unit and the
  deploy's require-step (mirroring ADR-0028's revisit trigger).

## Amendment (2026-09-21, owner decision in the cutover thread): reviewer re-headed to DeepSeek; Moonshot removed

The reviewer chain designed in #189 (`kimi:kimi-k2.6` head) requires
`MOONSHOT_API_KEY`, which the owner does not hold and has elected never to
provision: "please remove Moonshot API key, I would never use it." The owner
directed the reviewer to be served from the held key set (DeepSeek / Gemini /
Jev / TypeSafe). Of those, only DeepSeek has a `generate`-capable paid
candidate; TypeSafe JEV is `decide`-only and Gemini's row is free-tier, which
the `PromptSpec.personalData` enforcement refuses by design.

Decision:

- `reviewer` and `reviewer-live` chains are headed `deepseek:deepseek-v4-flash`.
  **Same-vendor review is accepted deliberately** — the anti-self-review
  property ADR-0009/ADR-0015 recorded is relaxed for the current key set and
  the trade-off is stated here rather than drifted into. Revisit trigger: any
  second paid vendor key (kimi, qwen) being provisioned restores cross-vendor
  review by re-editing the chain — config only, no code change.
- The `kimi` vendor row is removed from `models.json` and from the register
  surfaces (privacy notice, Art. 30 record); `MOONSHOT_API_KEY` is removed
  from `env.ts`, `server.ts` PASSTHROUGH_KEYS, `api.env.example`, and the
  runbook's key preconditions. ADR-0009's vendor-allowlist text is history and
  is not edited retroactively; this amendment is the operative record.

## Amendment (2026-09-21, owner decision): the deploy identity is a dedicated account with a two-command sudo grant

Decision 3 fixed _where_ the deployer lives (outside `apps/`) but left the
_identity_ it authenticates as to the host: the deploy ran as the owner's
personal admin login. That was never a decision, and it broke as soon as it was
tested. The cutover's closing step removed the temporary blanket
`NOPASSWD:ALL` rule step 0 had installed for the session
(`docs/VPS-CUTOVER-RECORD.md`), and the next push to `main` failed at the
restart step — `sudo: a password is required`, with the tree already shipped
(Staging run 35548824035). The three-command grant `docs/VPS-OPERATIONS.md`
§1.5 documented as the deploy user's requirement had never been installed:
deploys had been running on the session's temporary rule, so removing it
removed the deploy's ability to restart the service with no warning and no
test covering the gap.

The owner directed a dedicated account rather than widening the admin login's
grant back. Decision:

1. **The deploy identity is `kajianq-deploy`, a dedicated unprivileged login
   account**, created by `provision/vps/apply.sh`. The name is fixed, not
   configurable: sudoers grants are per-username, and a configurable name would
   let the account, the grant, and CI's `VPS_USER` disagree silently — the
   failure mode being the same unnamed "a password is required" this amendment
   removes. The three places are pinned in agreement by test, and `apply.sh`
   refuses to install a grant that does not name the account it just created.
2. **The grant is exactly two commands**, shipped as code in
   `provision/vps/sudoers/kajianq-deploy` and installed at
   `/etc/sudoers.d/kajianq-deploy` (root:root 0440) only after the candidate
   passes `visudo -cf` — a malformed file in that directory can lock sudo out
   of the box entirely, so the parse gates the install rather than following
   it. `systemctl restart kajianq-api.service` and
   `systemctl start kajianq-cron.service`, by absolute path, no wildcards. The
   read-only `systemctl is-active` check is **not** granted: unit state is
   world-readable (verified on the box), so it needs no privilege, and the
   deploy script drops the `sudo` it used to carry. The grant is one command
   smaller than the pre-amendment documentation claimed — because that
   documentation was never tested against a real least-privilege install.
3. **The deploy identity owns the deployed tree.** It replaces the previous
   arrangement (tree owned by the admin login, group `kajianq`), so the
   `rsync --delete` and its time-preservation pass need no group-write grant.
   The service account is deliberately _not_ given write access as the cheaper
   fix: the API never writes to this tree, so widening the serving identity
   there would grant an ability nothing requires. The migration needs a
   recursive `chown`, since `install -d` fixes directories and leaves existing
   files behind — which is exactly the `failed to set times` failure the ops
   manual records from the first deploy attempts.
4. **The gap is closed by test, not by prose.** The original defect was that a
   documented host precondition had no executable existence. Five pins in
   `tests/scripts/vps-hardening.test.mjs` now fail the build when: a `sudo` in
   the deploy script has no matching grant; the grant allows a command the
   deploy never runs (an unused grant is privilege widening that looks
   harmless); the grant carries a wildcard, a shell, or a non-absolute path;
   the `visudo` gate is removed from the install path; or the deployed tree
   stops being owned by the deploy identity. Each pin was verified to fail
   against the defect it guards, not merely to pass on the fixed tree.

**Boundary stated rather than overclaimed:** the deploy identity ships the code
`kajianq-api.service` executes and may restart that unit, so it is trusted
equivalently to the serving process. This narrows _what the credential can
reach_ (no root shell, no other unit, no read of the root-only
`/etc/kajianq/*.env`), not _how far the deploy itself is trusted_.

Revisit triggers: the deploy identity's trust is judged insufficient (the fix
is a root-owned installer that fetches the artifact itself rather than
executing a deploy-supplied entrypoint); a second deploy target arrives; or a
human operator needs to deploy from a workstation, which means its key joins
the same `authorized_keys` — supported, but a separately-recorded choice.
