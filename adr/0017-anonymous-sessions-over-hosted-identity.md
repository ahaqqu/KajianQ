# ADR-0017: Anonymous sessions over hosted identity for v1

## Status

Accepted (2026-08-23). Amends the auth approach inherited from `agentic-project-template` (D1-backed anonymous sessions) for the Neon/RagStore foundation (#4). Supersedable by a future ADR when real user identity is added.

## Context

The v1 spec (`SPECS.md` §3.1) chose *anonymous-session auth (matches anonymous feedback)*: users ask questions, receive cited answers, and give anonymous thumbs + trace-anchored flags (ADR-0007). There are no user accounts, no login, no OAuth, and no email/password in v1. The template's session implementation was D1-backed; #3 removed it when D1 was stripped, and amended #4 to re-land sessions Postgres-backed behind the RagStore seam (ADR-0008).

During #4 planning, a question surfaced: should KajianQ use **Neon Auth** (Neon's "Managed Better Auth" — a hosted identity product offering OAuth, email/password, JWT, and session management, with auth state in a `neon_auth` schema accessed via Neon's own REST API/SDK) instead of rolling anonymous sessions in the KajianQ schema?

## Decision

**Do not adopt Neon Auth (or any hosted identity provider) for v1.** Implement anonymous sessions as first-class KajianQ tables (`users`, `sessions`) in the first Neon migration, accessed exclusively through the `RagStore` adapter (`createSession` / `resolveUserId` / `deleteUserCascade`). Re-mount `POST /v1/auth/anonymous` and `DELETE /v1/auth/me` behind the existing `authGuard` in #10.

## Rationale

1. **Neon Auth solves a problem KajianQ v1 does not have.** It is an identity provider for "who are you" — OAuth, email/password, user accounts. KajianQ v1 only needs "give this browser a 30-day Bearer token so feedback and rate limits persist." A hosted identity product is materially more machinery than the anonymous model the spec selected.

2. **It bypasses the RagStore seam (ADR-0008), a non-negotiable rule.** All database access goes through the `RagStore` adapter. Neon Auth's SDK reads/writes the `neon_auth` schema through its *own* REST API, outside the adapter — a second persistence path and a seam violation. Using it faithfully breaks the rule; using only its schema through RagStore defeats the point of the product.

3. **It couples auth to Neon, breaking pluggability.** ADR-0008 placed Neon *behind an adapter* precisely so swapping Neon for another Postgres (or SQLite) changes only the adapter. Neon Auth is a Neon-specific product; swapping the database would force an auth rewrite. Anonymous sessions in owned tables travel with the schema.

4. **Beta and a new billing dimension.** Neon Auth is in Beta (a trust risk on a foundation carrying a `model:high` correctness invariant) and bills by Monthly Active Users — a cost axis for tokens that are currently free to mint. ADR-0009 already records that price is weighed in every model/service decision; adding a billed identity layer for anonymous sessions fails that test.

## Consequences

- **#4** adds `users` and `sessions` tables to the first Neon migration (anonymous, 30-day Bearer token, cascade delete) — distinct from `chat_sessions` / `chat_messages` — and `RagStore` gains `createSession` / `resolveUserId` / `deleteUserCascade` (already recorded as #4 ACs). `RagStore` also gains `cleanupExpiredSessions(before?)` (implemented in the #4 review fix-forward, PR #62), which `DELETE`s `sessions` rows whose `expires_at` has passed and returns the count.
- **#10** re-mounts the auth routes behind `authGuard`; the session token seeds the `Authorization: Bearer` header for chat/feedback. **#10 also wires the cleanup job:** `resolveUserId` already rejects expired rows on read (so expiry is a storage-reclamation concern, not a correctness one), but expired rows are never removed by the read path. A Cloudflare Worker cron trigger (`[triggers] crons` in `apps/api/wrangler.toml` + a `scheduled()` handler) must call `ragStore.cleanupExpiredSessions()` on a schedule (e.g. nightly) once #10 mounts the `RagStore` in the Worker. This is a #10 acceptance criterion, not engine work.
- Auth remains swappable: changing the session store is a RagStore adapter change, not an app change.
- No vendor identity SDK enters the engine or app; the `check-boundary.mjs` gate already forbids vendor/client coupling in engine packages.

## When to revisit

A future milestone that adds **real user identity** — saved reading lists, cross-device history, personalized bookmarks, or paid tiers — makes a hosted identity product (Neon Auth, or Clerk) genuinely useful. That is an ADR-level decision with real trade-offs (cost, seam, vendor lock-in, migration of anonymous → named sessions) and should amend or supersede this ADR. Until then, anonymous sessions are the v1 posture.