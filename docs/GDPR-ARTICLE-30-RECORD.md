# Record of processing activities — KajianQ (Art. 30 GDPR)

Internal controller-side record under **Art. 30(1) GDPR** for the KajianQ chat
service, scoped to the netcup VPS deployment decided in
[`adr/0043-netcup-vps-hosting-gdpr-posture.md`](../adr/0043-netcup-vps-hosting-gdpr-posture.md).
Issue: #178 (GDPR-B). The companion note is
[`docs/GDPR-DPIA-LITE.md`](./GDPR-DPIA-LITE.md).

This document is the **derivation source** for the categories declared in the
netcup DPA. Section
[§9 CCP declaration](#9-ccp-declaration-master-data--order-processing) is the block
the owner copies into the netcup Customer Control Panel. Values here — retention
windows, processor rows, data categories — are fixed by ADR-0043 and must not
drift from it: ADR-0043 is the source of truth, this record is its Art. 30
rendering.

**Status of the DPA itself.** Concluding the DPA is an owner action (Master Data
→ Order Processing in the netcup CCP) and is tracked by #178. It is a
**precondition of hosting**, not paperwork to follow the move: per ADR-0043
decision 2, the DPA is concluded before any personal data lands on the netcup
box. "Ask again at the next login" is deliberately **not** used as the decision —
it suppresses a notice for 14 days and discharges nothing.

## 1. Why this record exists (Art. 30(5))

Art. 30(5) exempts organisations with fewer than 250 employees from keeping
records of processing activities, but only where the processing is occasional,
carries no risk to data subjects, and involves no special-category data. None of
those three conditions holds here:

- the processing is **not occasional** — it is the continuous chat service;
- chat content **can reveal religious convictions**, i.e. Art. 9 data (see §5);
- the service is anonymously reachable by an indefinite public (SPECS §1.1/§2.1).

The exemption therefore does not apply and the record is kept. The household
exception (Art. 2(2)(c)) is likewise rejected in ADR-0043's context section for
the same reason; the operator is the controller (Art. 4(7)) processing through
processors (Art. 4(8)).

## 2. Controller

| Field                    | Value                                                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controller               | **Angga** (GitHub [`ahaqqu`](https://github.com/ahaqqu)) — a natural person, acting as the controller (Art. 4(7)) as the operator of KajianQ                                                                                                                     |
| Product                  | KajianQ — open-source Islamic classical-knowledge chatbot, anonymously reachable at `/v1/*`; pre-public-beta (SPECS §1.1/§2.1, §7 phase 3)                                                                                                                       |
| Contact                  | The operator's GitHub account `@ahaqqu` is the public contact channel today. A dedicated privacy contact and a postal address are **owner-supplied** fields: the owner states them in the CCP declaration and in the notice (#179). This record invents neither. |
| DPO                      | None designated. The Art. 37(1) thresholds (public authority; large-scale regular and systematic monitoring; large-scale special-category processing) are not met at the present scale. Revisit trigger is shared with the DPIA-lite note.                       |
| Representative (Art. 27) | None. The controller and the processor netcup GmbH are both in the EU (Germany).                                                                                                                                                                                 |

## 3. Processing activities at a glance

| #   | Purpose                                                                                  | Data subjects      | Categories                                                                   | Indicative Art. 6 basis | Retention                                                                       |
| --- | ---------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| P1  | Provide the chat service: mint an anonymous session, answer questions with cited sources | Anonymous visitors | Session identifier + token hash; chat questions and answers; persisted Trace | Art. 6(1)(b)            | 30 days of inactivity; erasure on demand                                        |
| P2  | Abuse prevention and service integrity: per-IP rate limiting                             | Anonymous visitors | IP address (transient runtime key)                                           | Art. 6(1)(f)            | Transient runtime state; never written to a log file                            |
| P3  | Operate and secure the service: server access logs, incident triage                      | Anonymous visitors | IP address, request line, timestamp (reverse-proxy access log)               | Art. 6(1)(f)            | 14 days                                                                         |
| P4  | Improve answer quality from trace-anchored feedback                                      | Anonymous visitors | Optional free-text feedback; rating; Trace anchor                            | Art. 6(1)(f)            | Follows P1 (cascade-deleted with the user)                                      |
| P5  | Durability of the paid corpus and disaster recovery                                      | Anonymous visitors | Full-database backup (contains P1/P4 rows); snapshot archives                | Art. 6(1)(f)            | 30-day rolling backups; superseded snapshots 30 days after a successor verifies |

The Art. 6 basis is **indicative, not a legal determination**: it records the
operator's working assumption for each activity and is one of the items the
owner confirms. Where an activity carries Art. 9 content, the further Art. 9(2)
condition is addressed in §5 and the DPIA-lite note.

Processing with **no personal data** (recorded for completeness, out of Art. 30(1)
scope): corpus ingestion and translation (`ingest:quran`, `ingest:hadith`,
`ingest:kitab`) and the eval harness run against corpus text, and the Golden Set
is content, not personal data.

## 4. What is actually stored

The categories below are verified against the schema in
`packages/infra/migrations/0001_init.sql` and the seams that write it. An
anonymous user is a `users` row; everything they own references it with
`ON DELETE CASCADE`, so the whole subtree is one erasure unit.

| Data category                                     | Where it lives                                                                          | Notes                                                                                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session identifier                                | `users.id` (random UUID, `kind = 'anonymous'`)                                          | No account, no email, no name — ADR-0017.                                                                                                                                             |
| Session token                                     | `sessions.token_hash` (SHA-256 of the Bearer token), `expires_at`                       | The plaintext token never touches the database; it is returned to the client exactly once. Expiry (30 days) is enforced on read, so expiry is a reclamation concern, not correctness. |
| Chat questions and answers                        | `chat_sessions`, `chat_messages`                                                        | The transcript. A returning user sees their own transcript (ADR-0040 rehydration).                                                                                                    |
| Persisted Trace                                   | `answer_traces` (keyed `user_id`, `message_id` unique)                                  | The `@app/contracts` `Trace` verbatim: router intent, sub-queries, retrieved chunk refs with fused scores, model identities, tokens in/out, cost, latency (ADR-0007).                 |
| Feedback                                          | `feedback` (`rating`, `anchor_type`, `anchor_id`, `category`, optional `free_text`)     | `free_text` is capped at 2000 characters (`FeedbackRequestSchema`); it is free text and can contain anything the user types.                                                          |
| IP address — transient                            | Rate-limiter key `ip:<ip>`; the Durable Object is named by the FNV-1a digest of the key | Never persisted to a log file and never stored in the database; the digest is what names the object (`packages/rate/src/rate-limiter.ts`).                                            |
| IP address — logged                               | Reverse-proxy access log on the VPS                                                     | Personal data per CJEU _Breyer_. Deliberately retained only 14 days so the log never becomes the de-facto record of who asked what (ADR-0043 decision 4).                             |
| Full-database backup                              | Encrypted backup target, key held outside the repo                                      | Contains all of the above. Encrypted at rest, 30-day rolling, restores re-apply erasure (ADR-0043 decision 4).                                                                        |
| Snapshot archive (`pre-ingest-*`/`post-ingest-*`) | ObjectStore snapshot prefix (R2 today)                                                  | A whole-database `pg_dump`, so it already carries `users`/`sessions`/`chat_*`/`answer_traces`/`feedback`. Flagged as a personal-data-bearing location in ADR-0043 decision 5.         |

The client stores the session id and token (plus the theme preference) in
`localStorage` under the `kajianq.*` keys; the selected language is in-memory
shell state today, not persisted. There are **no cookies** and no client-side
persistence layer beyond that.

## 5. Special-category data (Art. 9)

Chat content **can reveal religious convictions** — a fiqh or aqidah question
discloses something about the asker's belief or practice. This is stated plainly
because silence would be the dangerous option: with the persisted Trace, the
question is stored alongside the retrieved passages, so the Art. 9 dimension is
real even under an anonymous session.

What the record claims, and what it does not:

- KajianQ **does not ask for** religious conviction, affiliation, health, or any
  other Art. 9 attribute; there is no onboarding, no profile, and no field that
  collects one. Disclosure is incidental and voluntary, made by the data subject
  in the course of asking their own question.
- The service is **anonymous by design** (ADR-0017): pseudonymous identifiers, no
  accounts, no email. This reduces but does not remove the Art. 9 character of
  the content — the convictions are in the text, not in the identifier.
- No profiling, no automated decision-making with legal or similarly significant
  effects, and no systematic monitoring of a publicly accessible area (see the
  DPIA-lite note for the Art. 35(3) analysis).

Whether an explicit Art. 9(2) condition needs to be surfaced in the product at
public beta is recorded as an **open item in §10** for the owner's legal review —
it is not asserted as settled here.

## 6. Retention

The values are ADR-0043 decision 4 verbatim; the notice (#179) states them and
GDPR-D (#180) implements the log and backup halves as code under
`provision/vps/` (see [`docs/VPS-HARDENING-RUNBOOK.md`](./VPS-HARDENING-RUNBOOK.md)
for the on-host steps and the restore test).

| Category                                        | Retention                                                                                                                                                                                                                                                            | Enforced by                                                                                                                                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anonymous sessions and their whole subtree      | **30 days of inactivity** (ADR-0017, unchanged). There is **no separate age-based deletion of chat rows** — a session that keeps being used keeps its transcript. Effective retention for anonymous chat is therefore 30 days of inactivity, plus on-demand erasure. | Nightly cron `cleanupExpiredSessions`, `crons: ["17 3 * * *"]` in `apps/api/alchemy.run.ts`, handler in `apps/api/src/lib/scheduled.ts`; the store call is `cleanupExpiredSessions` in `packages/infra/src/rag-store-neon-session.ts` |
| Erasure on demand                               | Immediate; cascades sessions, chat sessions/messages, persisted Traces, and feedback                                                                                                                                                                                 | `DELETE /v1/auth/me` (`apps/api/src/routes/auth.ts`) → `deleteUserCascade` on the `RagStore` seam (Art. 17 path)                                                                                                                      |
| Server access logs                              | **14 days**, logrotate daily and size-capped                                                                                                                                                                                                                         | `provision/vps/logrotate/kajianq-proxy` — GDPR-D, #180 (applied on the host by `provision/vps/apply.sh`)                                                                                                                              |
| API structured logs                             | Carries a correlation id and **no IP address**                                                                                                                                                                                                                       | Capped at 14 days / 512M by `provision/vps/journald/kajianq.conf`; the no-IP property is in `packages/infra/src/logger.ts` — GDPR-D, #180 (see the measured note below)                                                               |
| Rate-limit counters                             | Transient runtime state; never written to a log file                                                                                                                                                                                                                 | `packages/rate` (Durable Object / bounded in-memory)                                                                                                                                                                                  |
| Backups                                         | **30 days rolling**, encrypted at rest, key outside the repo, rotated daily; a restore re-applies erasure for the affected window                                                                                                                                    | `provision/vps/backup/kajianq-backup.mjs` (`restic forget --keep-daily 30 --prune`) + `kajianq-restore.mjs` (re-applies erasure) — GDPR-D, #180                                                                                       |
| Superseded snapshot archives with personal data | Deleted **30 days after** their successor was verified — an explicit deletion by label, never an overwrite (the immutable-label rule stands)                                                                                                                         | ADR-0038 + ADR-0043 decision 5; GDPR-E, #181                                                                                                                                                                                          |
| Newest verified snapshot per environment        | Retained — it is the paid corpus's durability layer (ADR-0038)                                                                                                                                                                                                       | `bun run db:snapshot verify`, ADR-0038                                                                                                                                                                                                |

## 7. Technical and organisational measures (TOMs)

| Measure                                                                                                      | Evidence in the repo                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Status                                                                     |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| TLS in transit; strict security headers (CSP, COOP/CORP, HSTS, nosniff, X-Frame-Options, Permissions-Policy) | `packages/hardening/src/security-headers.ts` (`installSecurityHeaders` via Hono `secureHeaders`)                                                                                                                                                                                                                                                                                                                                                                        | Implemented                                                                |
| No secrets in the repo and none on disk                                                                      | Secrets are deploy-time bindings (`Config.redacted` → `secret_text` in `apps/api/alchemy.run.ts`); `.env` gitignored; CI runs gitleaks and Semgrep                                                                                                                                                                                                                                                                                                                      | Implemented                                                                |
| Session tokens: plaintext never stored                                                                       | Only the SHA-256 hash is persisted (`sessions.token_hash`); expiry enforced on read in the adapter                                                                                                                                                                                                                                                                                                                                                                      | Implemented                                                                |
| Erasure cascade (Art. 17)                                                                                    | `DELETE /v1/auth/me` → `deleteUserCascade`; FK `ON DELETE CASCADE` from `users` through sessions, chat sessions/messages, `answer_traces`, `feedback`                                                                                                                                                                                                                                                                                                                   | Implemented                                                                |
| Storage limitation: bounded sessions                                                                         | Nightly `cleanupExpiredSessions` reclaims expired `sessions` **and** the anonymous `users` left with no session, so an abandoned browser cannot leave permanent rows                                                                                                                                                                                                                                                                                                    | Implemented                                                                |
| Data minimisation in logs                                                                                    | Structured API logs carry a correlation id and no IP address; rate-limit counters are transient and never logged                                                                                                                                                                                                                                                                                                                                                        | Implemented                                                                |
| Access control at the database boundary                                                                      | All database access goes through the `RagStore` adapter; `scripts/check-boundary.mjs` forbids direct DB-client imports outside the adapter and migrations                                                                                                                                                                                                                                                                                                               | Implemented                                                                |
| Abuse control                                                                                                | Per-IP rate limiting on the `/v1` surface only (ADR-0041); the limiter names its state by digest, never by raw IP                                                                                                                                                                                                                                                                                                                                                       | Implemented                                                                |
| CORS locked to known origins                                                                                 | `ALLOWED_ORIGINS` (empty by default ⇒ cross-origin blocked); enforced in `apps/api`                                                                                                                                                                                                                                                                                                                                                                                     | Implemented                                                                |
| Anonymous-by-design; no client tracking cookies                                                              | ADR-0017 (no accounts, no email); `localStorage` for session id/token and theme only — no cookie is set anywhere                                                                                                                                                                                                                                                                                                                                                        | Implemented                                                                |
| Encrypted backups at rest, off-repo key                                                                      | `provision/vps/backup/kajianq-backup.mjs` — restic client-side encryption, 30-day rolling (`forget --keep-daily 30 --prune`), repository key `/etc/kajianq/restic.pass` (mode 0600, outside the repo; the script refuses a group/world-readable key)                                                                                                                                                                                                                    | **Implemented as code (#180); not yet applied on the host — owner**        |
| Restore re-applies erasure (no resurrection)                                                                 | `provision/vps/backup/kajianq-restore.mjs` refuses a `--target-url` naming the live database (normalized location comparison; `PGDATABASE_URL` required so the guard cannot be silently disabled) and re-runs the `cleanupExpiredSessions` semantics plus the Art. 17 cascade (user id bound as a psql variable, drift from `deleteUserCascade` pinned by test); `restore-drill.mjs` proves it (resurrect-then-erase), run by `.github/workflows/vps-restore-drill.yml` | **Implemented and CI-verified (#180); on-host run owner**                  |
| Access-log retention enforced by logrotate                                                                   | `provision/vps/logrotate/kajianq-proxy` — 14 days total (current day + 13 rotated segments), daily, `maxsize 100M`, nginx reopened on SIGUSR1; the access-log format in `provision/vps/nginx/kajianq.conf` carries the client IP and no user-agent/referrer/$remote_user                                                                                                                                                                                                | **Implemented as code (#180); not yet applied on the host — owner**        |
| Postgres and API logs bounded                                                                                | `provision/vps/logrotate/kajianq-postgres` (14 days, copytruncate) and `provision/vps/journald/kajianq.conf` (14 days / 512M); `provision/vps/postgres/99-kajianq.conf` keeps `log_statement = 'none'` so a chat question never lands in an ops log                                                                                                                                                                                                                     | **Implemented as code (#180); not yet applied on the host — owner**        |
| Reverse proxy establishes the limiter's client IP, not the caller                                            | `provision/vps/nginx/kajianq.conf` overwrites `CF-Connecting-IP` from `$remote_addr`, the header `apps/api/src/lib/middleware.ts` reads — a caller cannot mint a fresh rate-limit key per request                                                                                                                                                                                                                                                                       | **Implemented as code (#180)**                                             |
| EU/Germany residency                                                                                         | netcup GmbH VPS (Germany/EU) holding the API and self-hosted Postgres                                                                                                                                                                                                                                                                                                                                                                                                   | **GDPR-E, #181** (today: Cloudflare Workers + Neon, the transitional path) |
| Personal data never routes through a vendor's free tier                                                      | `personalDataAllowed` per vendor in `packages/infra/src/providers/models.json`, enforced by `FallbackProvider` in `packages/infra/src/providers/provider-factory.ts` for any call whose `PromptSpec`/`EmbedSpec` sets `personalData: true`                                                                                                                                                                                                                              | **Seam implemented; not yet exercised — see §10**                          |

## 8. Recipients and sub-processor chain

Derived from ADR-0043 decision 3. **ADR-0043 is the source of truth** for this
table — it is the same register the notice renders (#179), and its `Tier` column
is a compliance field, not a cost note. A tier change re-opens the row's verdict,
so `models.json` price/free-tier edits are privacy-relevant changes.

| Processor                  | Role                                                                                                                                                              | Personal data seen                                                                                                                                   | Tier                    | Verdict                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **netcup GmbH** (DE)       | VPS host: reverse proxy, API process, Postgres + pgvector, DB backups                                                                                             | All of it — session token hashes, chat questions/answers, persisted Traces, feedback incl. optional free text, IPs in access logs, encrypted backups | **Paid** (VPS contract) | **Permitted.** DPA mandatory (Art. 28(3)); conclusion is the owner's CCP action, #178 — **not yet concluded**                              |
| Cloudflare, Inc. (US)      | Transition: Workers runtime, static assets, R2 (raw corpus + snapshot archives), Durable Objects (rate limiter), DNS. Post-cutover: DNS, optionally the CDN proxy | IPs (`CF-Connecting-IP`, edge logs), chat content in flight, snapshot/backup archives once the DB moves                                              | Free tier today         | Permitted for the transition; the row **narrows to DNS/proxy** at cutover                                                                  |
| Neon, Inc. (US)            | Transition: managed Postgres + pgvector — the whole product schema                                                                                                | Everything in the DB, including `users`/`sessions`/`chat_*`/`answer_traces`/`feedback`                                                               | Free plan               | **Transitional only**; retirement is GDPR-E (#181). Recorded residual risk: a free plan is not the posture the register's own rule prefers |
| Google (Gemini API)        | LLM: router (`cheap` role), reviewer, embeddings                                                                                                                  | Prompt/embedding content of any call flagged personal                                                                                                | Free tier               | **NOT permitted** for personal-data calls (`personalDataAllowed: false`)                                                                   |
| DeepSeek                   | LLM: generator — receives the question and the assembled context                                                                                                  | Chat question + context                                                                                                                              | Paid                    | Permitted (`personalDataAllowed: true`)                                                                                                    |
| Alibaba (Qwen / DashScope) | LLM: ingestion translation; catalogued generator challenger (key not provisioned)                                                                                 | Corpus text only in practice                                                                                                                         | Paid                    | Permitted                                                                                                                                  |
| Moonshot (Kimi)            | LLM: catalogued challenger, no serving role                                                                                                                       | None in serving                                                                                                                                      | Paid                    | Permitted                                                                                                                                  |
| TypeSafe AI                | Decision model, bench-only until the ADR-0042 gate is adopted for serving                                                                                         | Gate fixture text only                                                                                                                               | Paid                    | Permitted; no serving role references it                                                                                                   |

The register rule (the ADR-0009 amendment, made enforceable in ADR-0043):
**personal data never routes through a vendor's free tier**, because a free
tier's terms may permit use of the input beyond providing the service. A vendor
may carry personal data only on paid/standard terms with a DPA — which is what
the `personalDataAllowed` column encodes and `FallbackProvider` enforces at the
seam.

Snapshot archives are a personal-data-bearing location: the ObjectStore snapshot
prefix's vendor joins the register (Cloudflare/R2 today; whatever GDPR-E
provisions afterwards), and any archive carrying personal data is encrypted at
rest before personal data lands on the VPS.

## 9. CCP declaration (Master Data → Order Processing)

The owner concludes the DPA in the netcup Customer Control Panel under
**Master Data → Order Processing**, declaring the following. This is the block
the categories in §3/§4 were derived to fill.

| Declaration field     | Value to declare                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Controller            | The operator of KajianQ (owner-supplied name and contact details — §2)                                                                                                                                                                                                         |
| Processor             | netcup GmbH (Art. 28(1))                                                                                                                                                                                                                                                       |
| Purpose of processing | **Providing the KajianQ chat service**: answering user questions from a classical Islamic corpus with citations, and operating and securing that service                                                                                                                       |
| Data subjects         | **Anonymous visitors** (no accounts, no login, no email)                                                                                                                                                                                                                       |
| Data categories       | **Session identifiers/tokens** (SHA-256 token hash, 30-day expiry); **IP addresses in server access logs** (14-day retention); **chat messages with their persisted traces** (question, answer, retrieved sources, model/token/cost metadata); **optional free-text feedback** |
| Special categories    | Content **can reveal religious convictions** (Art. 9) — declare this honestly; see §5 and the DPIA-lite note                                                                                                                                                                   |
| Retention             | 30 days of inactivity for anonymous sessions and their subtree; 14 days for access logs; 30-day rolling encrypted backups; superseded snapshot archives deleted 30 days after a successor verifies                                                                             |
| Location              | netcup VPS, Germany/EU                                                                                                                                                                                                                                                         |
| Sub-processors        | Per ADR-0043's register (netcup GmbH does not receive LLM-vendor traffic; the LLM vendors are the controller's own processors)                                                                                                                                                 |

Ordering: conclude the DPA **before** any personal data lands on the box.
"Ask again at the next login" is not used as the decision.

## 10. Open items and known gaps

Recorded rather than implied. None of these is closed by this document.

| Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Owner                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| ~~**`PromptSpec.personalData` is not set by any serving call site.**~~ **CLOSED by #181 (2026-09-20).** The domain stage seams declare `personalData: true` as a required, literal-true field — a compile error to drop — and the serving chains carry paid, personal-data-allowed heads (`deepseek` for `cheap`/`generator`, `kimi` for `reviewer`, a new paid-terms `gemini-paid` row for `embedder`). Enforced by `apps/api/src/lib/personal-data-serving.test.ts`, which fails CI if a serving role loses its keyed candidate or a free-tier vendor returns to a chain head.       | Closed, #181                         |
| ~~The DPA is not yet concluded in the CCP.~~ **CLOSED (owner, 2026-09-19, #178)** — concluded in the netcup CCP; this record and the DPIA-lite derive from it.                                                                                                                                                                                                                                                                                                                                                                                                                         | Owner, #178                          |
| 14-day access-log retention, logrotate, encrypted backups, and the restore drill are implemented as **code and CI-verified** (`provision/vps/`, the `vps-restore-drill` workflow), but **not yet applied on the netcup VPS** — the box is empty until #181, and running `provision/vps/apply.sh` there plus the on-host restore drill is the owner's step (docs/VPS-HARDENING-RUNBOOK.md). This row closes when the owner reports the on-host drill green.                                                                                                                             | Owner, #180                          |
| ~~The API's `PromptSpec.personalData` serving gap (above) is still open.~~ **CLOSED by #181** — see the first row. The box may serve public traffic once the owner's cutover evidence (docs/VPS-CUTOVER-RUNBOOK.md) is in.                                                                                                                                                                                                                                                                                                                                                             | Closed, #181                         |
| The DPA/notice-facing privacy contact and postal address are not recorded in the repo (owner-supplied; deliberately not invented here).                                                                                                                                                                                                                                                                                                                                                                                                                                                | Owner, #179                          |
| Whether an explicit Art. 9(2) condition must be surfaced in the product at public beta — the current posture relies on anonymity plus incidental, voluntary disclosure.                                                                                                                                                                                                                                                                                                                                                                                                                | Owner's legal review, at public beta |
| No dedicated Art. 15 (access) or Art. 20 (portability) endpoint exists. A data subject can read their transcript via the rehydration endpoint and erase it via `DELETE /v1/auth/me`; a formal access/portability response is handled manually by the operator today. ADR-0043's revisit trigger (real user identity) is where these duties extend.                                                                                                                                                                                                                                     | Owner                                |
| **The Art. 17 right has an API but no in-product control yet** (#179). `DELETE /v1/auth/me` is the working erasure path, but the web app offers no erase button: clearing browser storage or starting a new session only drops the local session id and leaves the server rows. The `/about` privacy notice therefore names the endpoint and states the gap explicitly (`apps/web/src/lib/privacy-notice-erasure.ts`, `ERASURE.uiAffordance: "absent"`) rather than implying an affordance that does not exist. A discoverable erase control is follow-up product work at public beta. | Owner, at public beta                |

## 11. Indonesian law (UU No. 27/2022, PDP Law)

KajianQ's audience is Indonesian (SPECS §1.1), so this record also answers to
Indonesia's **PDP Law** (UU No. 27/2022), fully effective October 2024. KajianQ
is a **data controller** for Indonesian data subjects' personal data, in PDP
terms as in GDPR's — the two roles are the same operator here.

**Posture: GDPR-aligned, PDP-satisfying.** The PDP Law's data-subject rights
catalogue (information, correction, erasure, portability, objection,
restriction) is modeled on the GDPR, and the measures this record already
carries — lawful-basis-by-design anonymity, the §6 retention windows, the §7
TOMs, and the complete erasure cascade (§4) — substantially satisfy it. This is
stated once; the values are not restated here (ADR-0043 and §6/§7 remain their
source).

Two PDP duties have no direct GDPR analogue and are recorded explicitly:

| PDP duty                             | How it is discharged here                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Breach notification (Art. 46)**    | A personal-data breach with real harm carries a **3×24-hour** notification duty: to the affected data subjects, and — where the breach has material or indirect impact — to the authority (the PDP supervisory body). This is an **incident-response duty**, not a product feature: it joins the runbook's incident path (docs/VPS-HARDENING-RUNBOOK.md) and is exercised by the same operator who holds the DPA duties. Nothing in the record changes; the clock is what is new.         |
| **International transfer (Art. 56)** | After the VPS migration (#181) personal data leaves Indonesia for **Germany (netcup GmbH, EU)**. PDP permits transfer to a jurisdiction with **equivalent protection**, or absent that, with **adequate safeguards**. EU/GDPR-level protection qualifies as equivalent, and the DPA (Art. 28) plus the §7 TOMs are the safeguards of record. Residency rationale: ADR-0043 (`adr/0043-netcup-vps-hosting-gdpr-posture.md`, decision 1 — EU/Germany residency is the reason for the move). |

**Not owner-actionable.** This is a record of duties that follow from the
posture the ADR-0043 chain already commits to; it introduces no new processing
and opens no new gap. If a PDP-specific obligation ever outruns the GDPR
posture, it lands in §10 rather than here.

## 12. Keeping this record true

- Retention values, processor rows, and the Art. 9 posture are ADR-0043's; a
  change there changes this record in the same PR.
- Any `models.json` `freeTier`/`personalDataAllowed` edit is a privacy-relevant
  change (ADR-0043 decision 3) and must move this record's §7/§8 with it.
- The notice copy (#179) and this record must not diverge: #179 renders the
  register and retention values, this record records them.

## See also

- [`adr/0043-netcup-vps-hosting-gdpr-posture.md`](../adr/0043-netcup-vps-hosting-gdpr-posture.md) — the anchoring decision
- [`adr/0017-anonymous-sessions-over-hosted-identity.md`](../adr/0017-anonymous-sessions-over-hosted-identity.md) — the 30-day anonymous-session model
- [`adr/0007-user-facing-trace-and-feedback.md`](../adr/0007-user-facing-trace-and-feedback.md) — the persisted Trace and cascade erasure
- [`adr/0038-corpus-snapshot-durability-guardrail.md`](../adr/0038-corpus-snapshot-durability-guardrail.md) — snapshot labels and the durability layer
- [`docs/GDPR-DPIA-LITE.md`](./GDPR-DPIA-LITE.md) — the Art. 35 assessment and Art. 9 mitigations
- [`docs/VPS-HARDENING-RUNBOOK.md`](./VPS-HARDENING-RUNBOOK.md) — the on-host steps that turn §6/§7's #180 rows into running measures
- [`SPECS.md`](../SPECS.md) §3.2 — the hosting decision this record is scoped to
