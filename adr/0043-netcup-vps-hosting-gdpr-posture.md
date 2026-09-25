# ADR-0043: netcup VPS hosting — sub-processor register, retention values, and the GDPR posture that follows

## Status

Accepted (2026-09-19). The owner bought a netcup GmbH VPS and decided to move the
serving path onto it; this ADR records that decision, the DPA obligation it
creates, and the posture every other GDPR-A workstream ticket cites. It amends
ADR-0028 (the Cloudflare/Alchemy serving path becomes transitional rather than
final) and narrows ADR-0009's free-tier rule from an assertion into a register
column. It does **not** relitigate ADR-0007 (trace/feedback) or ADR-0017
(anonymous sessions) — hosting changes _where_ personal data is processed and
_who_ processes it, not the session model, the trace contract, or the 30-day TTL.

The migration itself is **not** this ADR: it is GDPR-E (#181).
**Status amendment (2026-09-20, #181):** the serving path and the database
adapter are now the VPS ones — see
[ADR-0044](0044-vps-serving-path-cutover.md), which supersedes ADR-0028's
serving path. The repo-side migration is complete (Bun behind nginx, `pg` over
TCP, vendor-free `DATABASE_URL`, the `PromptSpec.personalData` gap closed); the
**on-host** application, the single-shot cutover, and the owner-approved
decommissioning of Cloudflare + Neon are **executed** (2026-09-21) and recorded
in [`docs/VPS-CUTOVER-RECORD.md`](../docs/VPS-CUTOVER-RECORD.md), whose
acceptance-criteria checklist is what issue #181 is closed against. The register,
retention values, and the snapshot personal-data flag decided here are unchanged
and are what the implementation conforms to.

## Context

- The owner holds a netcup GmbH VPS. netcup's own contract notice states that
  concluding a Data Processing Agreement (DPA) within the meaning of
  **Art. 28(3) GDPR** is _legally obligatory_ when personal data is processed
  via netcup services, that netcup GmbH acts as a **processor pursuant to
  Art. 28(1) GDPR**, and that the DPA is concluded in the netcup **Customer
  Control Panel (CCP) under Master Data → Order Processing**. If no DPA is
  concluded, netcup _assumes_ no personal-data processing is carried out. The
  notice can be hidden for 14 days via "Ask again at the next login"; that is a
  UI suppression, not a discharge of the obligation.
- netcup also says it considers the **analogous application** of commissioned
  processing (and therefore a DPA) appropriate even for processing that falls
  under the so-called **household exception** (Art. 2(2)(c) GDPR), for reasons
  of data-subject protection.
- KajianQ is not a household activity. SPECS §1.1/§2.1 define it as an
  open-source Islamic classical-knowledge chatbot **for the Indonesian Muslim
  public**, an anonymously reachable service at `/v1/*` with no access
  restriction, heading for public beta (SPECS §7 phase 3). Art. 2(2)(c)
  exempts processing "by a natural person in the course of a purely personal or
  household activity" — a service made available to an indefinite number of
  people is not purely personal or household, so the exemption does not apply
  and the operator is a controller (Art. 4(7)) processing through processors
  (Art. 4(8)). **The DPA is mandatory.**
- The data the VPS would hold is not only logs. The product schema carries, per
  anonymous user: `users` + `sessions` (SHA-256 token hash, 30-day
  `expires_at` — ADR-0017), `chat_sessions` / `chat_messages` (the user's
  questions and the answers), `answer_traces` (ADR-0007, keyed `user_id`,
  cascade-deleted), and `feedback` (rating, anchor, optional `free_text`). All
  of it references `users` with `ON DELETE CASCADE`, so it is pseudonymous
  personal data tied to content — and fiqh/religious questions can reveal
  **religious convictions**, i.e. Art. 9 special-category data, even under an
  anonymous session. To that add IP addresses: a VPS reverse proxy logs them,
  and IP addresses are personal data (CJEU, _Breyer_).
- There is only one shape in which the DPA would not be needed on this host —
  keeping _all_ personal data off netcup (e.g. the box runs only the corpus
  ingestion/eval CLIs against a database that stays elsewhere). That is not the
  decision on the table; the point of the move is to hold the API and the
  database in the EU.
- The register below is not free-form prose: `packages/infra/src/providers/models.json`
  already carries `freeTier` and `personalDataAllowed` per vendor, and
  `FallbackProvider` (`provider-factory.ts`) filters candidates on
  `personalDataAllowed` for any call whose `PromptSpec`/`EmbedSpec` sets
  `personalData: true`. The rule this ADR fixes therefore has a seam it rides —
  and a measured gap (see Consequences).

## Decision

1. **netcup GmbH (Germany/EU) is the production host** for the Hono API, the
   reverse proxy, and Postgres + pgvector — implemented by ADR-0044 (#181). The
   Cloudflare Workers + Neon path is **superseded, not maintained in parallel**:
   the issue's zero-downtime-tolerance amendment (no live users, single-shot
   cutover) removed the rollback window this decision originally preserved, and
   the git history is the rollback. Decommissioning the old resources is
   owner-approved in review.

2. **The DPA is concluded in the netcup CCP (Master Data → Order Processing)
   before any personal data lands on the box**, and the declared categories
   match the product: session identifiers/tokens, IP addresses (server access
   logs), chat messages with their persisted traces, and optional free-text
   feedback; data subjects are anonymous visitors; the purpose is providing the
   KajianQ chat service. That CCP action is the owner's, not an agent's
   (GDPR-B #178, `model:plus-human`); "Ask again at the next login" is not used
   as the decision. The household exception is rejected on the analysis above,
   and even if it were arguable, the migration's own gate is stricter than the
   law's floor.

3. **Sub-processor register** (this table is the source the `/about` privacy
   notice renders, #179 — never hardcoded prose):

   | Processor                  | Role                                                                                                                                                              | Personal data seen                                                                                                                                      | Tier                                                                     | Personal-data verdict                                                                                                                      |
   | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
   | **netcup GmbH** (DE)       | VPS host: reverse proxy, API process, Postgres + pgvector, DB backups                                                                                             | all of it — session tokens (hashes), chat questions/answers, persisted traces, feedback incl. optional free text, IPs in access logs, encrypted backups | **paid** (VPS contract)                                                  | **Permitted**, DPA mandatory and concluded in the CCP (#178)                                                                               |
   | Cloudflare, Inc. (US)      | Transition: Workers runtime, static assets, R2 (raw corpus + snapshot archives), Durable Objects (rate limiter), DNS. Post-cutover: DNS, optionally the CDN proxy | IPs (`CF-Connecting-IP`, edge logs), chat content in flight, snapshot/backup archives once the DB moves                                                 | free tier today                                                          | Permitted for the transition; the row **narrows to DNS/proxy** at cutover                                                                  |
   | Neon, Inc. (US)            | Transition: managed Postgres + pgvector — the whole product schema                                                                                                | everything in the DB, including `users`/`sessions`/`chat_*`/`answer_traces`/`feedback`                                                                  | free plan                                                                | **Transitional only**, retirement is GDPR-E (#181). Recorded residual risk: a free plan is not the posture the register's own rule prefers |
   | Google (Gemini API)        | LLM: router (`cheap` role), reviewer, embeddings                                                                                                                  | prompt/embedding content of any call flagged personal                                                                                                   | free tier — free-tier traffic may be used to improve the vendor's models | **NOT permitted** for personal-data calls (`personalDataAllowed: false`, already encoded)                                                  |
   | DeepSeek                   | LLM: generator AND reviewer (same-vendor review accepted by owner amendment, 2026-09-21 — see ADR-0044 amendment)                                                 | chat question + context (both stages)                                                                                                                   | paid                                                                     | Permitted (`personalDataAllowed: true`)                                                                                                    |
   | Alibaba (Qwen / DashScope) | LLM: ingestion translation; catalogued generator challenger (key not provisioned)                                                                                 | corpus text only in practice                                                                                                                            | paid                                                                     | Permitted                                                                                                                                  |
   | TypeSafe AI                | Decision model, bench-only until the ADR-0042 gate is adopted for serving                                                                                         | gate fixture text only                                                                                                                                  | paid                                                                     | Permitted; no serving role references it                                                                                                   |

   **The register rule (ADR-0009 amendment, made enforceable here):** personal
   data never routes through a vendor's **free tier**, because a free tier's
   terms may permit use of the input beyond providing the service. A vendor may
   carry personal data only on paid/standard terms with a DPA, which is what
   the `personalDataAllowed` column encodes and `FallbackProvider` enforces at
   the seam. Two consequences follow: (a) the register's `Tier` column is a
   compliance field, not a cost note — changing a row's tier re-opens its
   verdict, so `models.json` price/free-tier edits are privacy-relevant
   changes; (b) Cloudflare/Neon's free tiers are permitted only as the
   _transitional_ rows above, whose personal-data footprint the migration
   removes.

4. **Retention values** (the notice, #179, states these; #178 records them in
   the Art. 30 register):

   - **Anonymous sessions: 30 days**, unchanged from ADR-0017 — plaintext
     tokens never touch the database, only the SHA-256 hash; expiry is enforced
     on read, and the nightly cron (`cleanupExpiredSessions`) reclaims expired
     session rows _and_ the anonymous `users` left with no session, which the FK
     cascade then removes with their `chat_sessions`/`chat_messages`/
     `answer_traces`/`feedback` subtree. **There is no separate age-based deletion
     of chat rows**: a session that keeps being used keeps its transcript, so the
     effective retention for anonymous chat is _30 days of inactivity_, plus the
     on-demand erasure below. That is a product decision (a returning user must
     still see their transcript), now stated rather than implied.
   - **Erasure on demand: `DELETE /v1/auth/me`** cascades the whole subtree
     (sessions, chat, traces, feedback) — the Art. 17 path, already implemented.
   - **Server access logs: 14 days**, deliberately chosen. The reverse proxy's
     access log carries IP addresses (personal data, _Breyer_), so it must not
     grow unbounded and must not be the de-facto system of record; 14 days
     covers abuse investigation and incident triage and nothing else. Rotation
     is enforced by logrotate (daily, size-capped); after 14 days the rotated
     segments are deleted. API structured logs carry a correlation id and no IP
     address, and rate-limit counters are transient runtime state, never written
     to a log file. Implemented by GDPR-D (#180).
   - **Backups: encrypted at rest, 30-day rolling retention.** A backup of the
     Postgres volume is personal data; it is encrypted at rest with a key held
     outside the repo, rotated daily, and retained 30 days — the session TTL,
     so a backup cannot meaningfully outlive the data it holds. Restores are
     tested once into a scratch location (#180). **A restore re-applies
     erasure**: backups are never used to answer a subject request, and after a
     restore the reclamation/erasure path is re-run for the affected window —
     otherwise a restored row would silently resurrect data the live store had
     deleted. The backup target is never a free tier.

5. **Snapshot labels may carry personal data — flagged explicitly, because
   verification semantics depend on it.** `bun run db:snapshot` takes a
   whole-database `pg_dump` (`packages/infra/scripts/db-snapshot.mjs`), so a
   `pre-ingest-<UTC>`/`post-ingest-<UTC>` archive already contains
   `users`/`sessions`/`chat_*`/`answer_traces`/`feedback` today, and its
   manifest records that snapshot's row counts for each of those tables. The
   move to the VPS does not create this — it makes the storage location EU/DPA
   covered and makes the exposure worth writing down. Therefore:

   - The ObjectStore **snapshot prefix is a personal-data-bearing location**:
     its vendor joins the register (Cloudflare/R2 today; whatever #180
     provisions afterwards) and any archive that carries personal data is
     **encrypted at rest** before personal data lands on the VPS. Until then,
     the portable layer's plaintext `pg_dump` on R2 is a recorded transitional
     exposure, owned by #180/#181.
   - **`bun run db:snapshot verify` semantics do not change, and must not be
     made to change.** The CLI already partitions row counts into corpus tables
     (`doc_parents`, `doc_children`, `aligned_pairs`, `schema_migrations`) that
     must match a manifest exactly, and ledger/personal tables that legitimately
     "moved on" and are only reported (`pg-conn.mjs`'s `CORPUS_TABLES`). That
     exemption is now privacy-relevant rather than ergonomic: a red verify must
     never be "fixed" by re-snapshotting without personal tables, and a snapshot
     label must never be deleted to reduce exposure — the paid-corpus
     durability guardrail (ADR-0038) outranks a cosmetic green.
   - **Retention bound:** the newest verified snapshot per environment is
     retained (it is the paid corpus's durability layer, ADR-0038); every
     **superseded** snapshot containing personal data is deleted **30 days**
     after its successor was verified. The immutable-label rule stands — that is
     an explicit deletion by label after a documented window, never an
     overwrite.
   - GDPR-E (#181) must generalize the CLI's `NEON_DATABASE_URL` source and
     re-do this analysis at cutover; the pre/post labels bracketing the
     migration are themselves personal-data-bearing archives.

   **A corpus-only projection is explicitly _not_ decided here.** It would be
   the clean answer (a durable archive that provably carries no personal data),
   but it cannot serve #181's transfer, and inventing a second snapshot tool to
   avoid a documented exposure would be more machinery than the risk justifies.
   Recorded as a revisit trigger instead.

6. **Posture amendments, and only those.** Hosting changes where the data sits
   and which entity processes it; it changes no product behavior. Specifically
   unchanged: anonymous sessions over hosted identity (ADR-0017 — 30-day TTL,
   no accounts), the user-owned trace and cascade erasure (ADR-0007), the
   `RagStore`/`ObjectStore` seams (ADR-0008 — Neon→self-hosted Postgres is an
   adapter and config change; engine code never imports a DB client), and the
   engine's purity rules. GDPR-B (#178) produces the Art. 30 record and the
   DPIA-lite note; GDPR-C (#179) renders the register and retention values on
   `/about`; GDPR-D (#180) implements the log/backup TOMs; GDPR-E (#181) moves
   the data. Each of them cites this ADR instead of restating it.

## Rationale

- **A DPA is a precondition, not paperwork to follow the move.** netcup's
  notice is explicit that _its_ assumption is "no DPA ⇒ no personal-data
  processing". Hosting first and concluding the DPA later would place the
  product's chat content and logs under a processor agreement that does not
  exist yet — the ordering in the ticket graph (#178 before #180, #181) is the
  legal ordering, not a scheduling preference.
- **The register is a table, not a paragraph, because three different audiences
  consume it.** The privacy notice renders rows, the Art. 30 record derives its
  sub-processor chain from it, and `models.json`'s `personalDataAllowed` is its
  machine-checkable shadow. One table with a `Tier` column is the only shape
  that keeps those three from drifting.
- **Fixing retention as numbers is what makes the notice honest.** Art. 13(1)(e)
  requires telling data subjects how long data is kept; "as long as needed" is
  not an answer the product can render. 14 days for access logs and 30 days for
  backups/superseded snapshots are choices made here so #179 and #180 can
  implement them.
- **The snapshot flag is written down because silence would be the dangerous
  option.** A whole-DB dump has always carried chat and feedback rows; the
  moment the database is EU-hosted and DPA-covered, an unexamined archive on a
  different vendor's storage is exactly the processing nobody declared.

## Alternatives considered

- **Self-host everything on the VPS but keep the database on Neon.** Rejected as
  the end state: the reason to move is EU/Germany data residency, and the
  database holds the personal data — leaving it on a US vendor's free plan would
  leave the largest processing outside the DPA. (It _is_ the shape of the
  transition, until #181 cutover.)
- **Keep Cloudflare Workers serving and use the VPS only for ingestion/eval
  CLIs.** That is the one shape with no DPA obligation at all, and it was
  rejected explicitly: it buys less residency than it appears to (Neon still
  holds the personal data) while adding a box to operate.
- **Self-host Postgres but keep Cloudflare in front as the only ingress.**
  Retained as an option, not a decision: a proxied DNS record hides the origin
  IP and absorbs volume, and it does not reduce what netcup processes (the box
  still holds the database). Cloudflare's row in the register is written to
  survive either choice.
- **Corpus-scoped dumps for snapshots, so no archive carries personal data.**
  Deferred, not rejected: it does not serve #181's transfer, and it would need a
  second tool alongside the existing one. Recorded as a revisit trigger.
- **A managed EU Postgres (e.g. an EU-region DBaaS) instead of self-hosting.**
  Rejected for now: it restores a vendor + DPA chain without restoring the
  operational savings that motivated the move, and the database's ops burden
  (backups, upgrades, restore drills) is the price #180/#181 already commit to
  paying. Revisit if the box's ops burden proves disproportionate.

## Consequences

- **Register rule vs. current chat path — the measured gap, now closed
  (#181).** The rule in decision 3 says personal data never routes through a
  free tier, and the seam enforces it via `PromptSpec.personalData`. When this
  ADR was written **no call site in the serving path set that flag**: the
  router, generator, and reviewer built `{ turns }` only, and the `cheap` role's
  chain head was the free-tier Gemini model. #181 closed it in two layers: the
  domain stage seams (`RouterProvider`, `GeneratorProvider`, `ReviewerProvider`,
  `RetrieverEmbedder`) declare `personalData: true` as a **required**, literal-
  true field — dropping the flag is a compile error — and the serving chains
  carry paid, personal-data-allowed heads (the `cheap`/`generator` roles on
  DeepSeek, the reviewer on Kimi, the embedder on a new paid-terms `gemini-paid`
  row for the same model and embedding space). `apps/api/src/lib/personal-data-serving.test.ts`
  fails CI if a serving role loses its keyed personal-data-allowed candidate or
  a free-tier vendor returns to a chain head. The free-tier Gemini row remains
  for non-personal calls (ingestion, tagging) and as a skipped tail.
- The corpus no longer depends on Neon's free-plan caps. ADR-0039's "smallest
  corpus that satisfies the gate" was forced by Neon's 0.5 GB write ceiling;
  on a VPS the ceiling becomes the disk, so the full corpus becomes a
  deployment-sizing question (#181) rather than a store limit. The gate's
  _scoping_ decision is untouched — this ADR only removes the constraint that
  motivated it.
- The single box is a single point of failure, and the Cloudflare-edge
  properties (anycast, DDoS absorption, instant rollback) stop being free. Both
  are accepted costs of the residency decision; the retained Cloudflare deploy
  is the rollback path, and a proxied DNS record is the documented mitigation.
- Self-hosting Postgres means the ops burden ADR-0038's restore discipline
  anticipated lands on the operator: TLS, logrotate, encrypted backups, restore
  drills, and the nightly session reclamation cron all become VPS
  responsibilities (#180/#181). The seams are already in place — which is why
  this is a deploy-path change, not an engine change.
- `bun run db:snapshot` reads `NEON_DATABASE_URL` and requires R2 credentials;
  post-cutover the source env var, the manifest's `source.host`, and the
  ObjectStore target all change (or the CLI gains a vendor-free env name). The
  manifest stays a provenance record, not a privacy record. **Resolved by
  ADR-0044 (#181):** the CLI reads the vendor-free `DATABASE_URL`, and its
  manifest gained a `privacy` block — `carriesPersonalData` (computed from the
  row counts, ADR-0043 decision 5's flag made checkable) plus the archive's
  asserted storage posture. `create` refuses to write a personal-data-bearing
  archive unless the target is asserted encrypted at rest or the plaintext
  transitional exposure recorded here is explicitly acknowledged.
- No new domain vocabulary is introduced (CONTEXT.md governs product terms:
  Kitab, Matn, Trace, Chat Session); "sub-processor register" and "access-log
  retention" are compliance artifacts, not product concepts, so CONTEXT.md is
  unchanged.

## Implementation map

- `adr/0043-netcup-vps-hosting-gdpr-posture.md` — this decision. SPECS.md §3.2
  (topology + provisioning), §5 (cost), §8 (Record of Decisions) are updated in
  the same PR.
- `packages/infra/src/providers/models.json` — `freeTier` (descriptive) and
  `personalDataAllowed` (enforced by `provider-factory.ts`) are the register's
  machine-checkable shadow; the chat-path flag gap is a serving-path change
  outside this docs PR.
- `apps/api/src/lib/scheduled.ts` + `packages/infra/src/rag-store-neon-session.ts`
  — the 30-day reclamation the retention section describes (already implemented).
- `packages/infra/scripts/db-snapshot.mjs`, `pg-conn.mjs`, `snapshot-store.mjs`
  — snapshot creation/verification and the corpus-vs-ledger partition.
- Downstream tickets that cite this ADR: #178 (DPA + Art. 30 + DPIA-lite),
  #179 (notice copy), #180 (log/backup TOMs), #181 (the migration).
- `docs/ARCHITECTURE.md` §15 (Platform row) and §8 (secrets landing as
  Cloudflare `secret_text`) describe the _current_ stack truthfully and change
  with GDPR-E (#181), not here — this ADR records the decision, it does not
  pretend the migration happened.

## Revisit triggers

- A second deployment region, or an EU-region managed Postgres whose DPA/ops
  economics beat self-hosting.
- Snapshot archives becoming a real exposure (a leak, an audit finding, or a
  growing ObjectStore bill) → take the corpus-only projection.
- netcup changing its sub-processor list (Art. 28(2)) → re-verify the register
  row and the notice copy.
- The product adopting real user identity (the ADR-0017 revisit trigger) →
  Art. 15/17 duties extend beyond cascade erasure, and this register's data
  categories grow.
- Any serving stage moving onto a new vendor, or a `models.json` tier change →
  the register row and `personalDataAllowed` must move together.

## Amendment (2026-09-21, carried with ADR-0044's amendment): Moonshot removed; reviewer re-headed to DeepSeek

The owner elected (issue #181 cutover thread) never to provision a Moonshot
key: "please remove Moonshot API key, I would never use it." The `kimi`
vendor row above is therefore removed from this register and from every
register surface it feeds (`models.json`, the `/about` notice, the Art. 30
record). The reviewer chain is re-headed to `deepseek:deepseek-v4-flash`,
accepting same-vendor review deliberately — the trade-off and the revisit
trigger are recorded in ADR-0044's amendment. The register rule itself is
unchanged; DeepSeek remains a paid, `personalDataAllowed: true` row.
