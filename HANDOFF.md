# Handoff prompt — KajianQ v1, session 3

Paste everything below the line into a fresh agent session.

---

## Mission

Implement **issue #4 — "P0: Neon + pgvector behind RagStore adapter, full schema, R2 wiring"** of `ahaqqu/KajianQ`. It is unblocked now that #3 (monorepo foundation) is merged and live. Finishing it unblocks #5 (Provider interface) and the corpus/Smart-Router tickets (#6, #7, #10, #14, #15).

## Where #3 left off (read this first — do not redo it)

#3 is **complete and merged to main** (PR #36, all 10 ACs ticked, issue #3 closed-by-ACs). The foundation is live:

- Monorepo with 6 workspace packages: `contracts`, `infra`, `rag-core`, `rag-ingest`, `eval`, `kajianq-domain` (all `@app/*`, all typecheck clean).
- `packages/contracts` already defines the typed trace contract `Trace` / `TraceEvent` / `CostRecord` (ADR-0007 amendment) — consume it, do not redefine it.
- `packages/rag-core` exports the pipeline interfaces `Router`, `Retriever`, `Assembler`, `Generator`, `Reviewer`, plus `Query` / `Chunk` / `Answer` types.
- `packages/infra` has the template adapters (Logger, ObjectStore/R2, ConfigStore, RateLimiter) and a `README.md` that already notes the four ADR-0014 concept-graph tables must be in the first Neon migration — read it.
- API shell `kajianq-api` (+`-staging`) deploys via CI to **https://kajianq-api-staging.rumaq.workers.dev**; only `/v1/health` + OpenAPI are mounted. The D1-backed session routes were removed in #3 — #4 re-lands them Postgres-backed (see auth ACs below).
- `scripts/check-boundary.mjs` enforces the engine boundary (no domain logic / vendor names / direct SQL in `rag-core`, `rag-ingest`, `eval`, `contracts`, `infra/src`). Run `bun run boundary` — keep it green.
- Staging deploys on push to `main`; template-sync is wired and seeded against upstream `main` (`bun run template-gate`).
- ADR-0017 ("Anonymous sessions over hosted identity for v1") was just written — it records the decision to use owned `users`/`sessions` tables via the RagStore seam, *not* Neon Auth. Read it before designing auth.

## Context you need

- Your ticket with acceptance criteria: `gh issue view 4 --repo ahaqqu/KajianQ --json body` (the `gh issue view` plain form errors on deprecated Projects classic — use `--json`). **Those ACs are your definition of done.** Note the three amendments already on the ticket: ADR-0013 (dual embeddings), ADR-0014 (four concept-graph tables), and the #3 strip (auth `users`/`sessions` tables + RagStore session methods).
- Read in the repo root, in this order: `CONTEXT.md` (domain glossary — vocabulary is enforced) → `AGENTS.md` (standing rules; §1.1 pluggable, §1.2 traceable, §2 non-negotiable) → these ADRs: `0008` (Neon+pgvector behind RagStore), `0007` (typed trace contract), `0013` (Arabic-canonical dual embeddings), `0014` (concept-graph tables + exact column definitions), `0017` (anonymous sessions, not hosted identity). `adr/0014` has the concrete table DDL for the four terminology tables — use it verbatim.
- `kajianq-dars-spec.md` is background; the spec's §0 chose anonymous-session auth.

## Credentials already provisioned (by the user)

- Cloudflare: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` are GitHub Secrets; `STAGING_URL` / `PROD_URL` are GitHub variables. R2 buckets `kajianq-raw` + `kajianq-raw-staging` exist.
- **Neon: the user is setting up `NEON_DATABASE_URL` (the pooled connection string, with `-pooler` hostname + `?sslmode=require`) as a GitHub Secret and in local `.env`.** `NEON_API_KEY` is optional for v1 (only for CI branching); do not block on it. Confirm with the user that `NEON_DATABASE_URL` is set before running migrations against staging.
- Vendor API keys (Gemini/Kimi/DeepSeek/Qwen) are **not** your scope — those are #5.

## Scope guardrails

- **All Neon access goes through the `RagStore` adapter in `packages/infra`.** No direct SQL, no DB client imports, outside the adapter and migrations (ADR-0008, AGENTS.md §2 rule 3). `check-boundary.mjs` already gates `@neondatabase|drizzle|\bpg\b|postgres(` in engine packages — keep it green; extend it only if needed.
- **No vendor or model names in engine code** (ADR-0009). The RagStore is vendor-agnostic; model choice is config.
- **No Islamic-domain logic in engine packages.** The RagStore schema columns are generic (`metadata` JSONB, `text_ar`/`text_id`); domain vocabulary (`madzhab`, `grade`, `textLayer`) lives in `kajianq-domain` and is passed through as filter values, never named in SQL or the adapter.
- **First migration = full v1 schema in one apply/rollback-clean migration:** `doc_parents`/`doc_children` (dual embeddings `embedding_ar`/`embedding_id VECTOR(1536)` + keep `text_raw`), `principle_index`, `concept_links`, `concept`/`lemma`/`concept_relation`/`lemma_evidence` (use ADR-0014's DDL), `chat_sessions`/`chat_messages`, `answer_traces`, `feedback`, `golden_questions`, `eval_runs`/`eval_results`, `model_configs`, and the new `users`/`sessions` (anonymous, 30-day Bearer, cascade delete — distinct from `chat_sessions`).
- **`answer_traces` stores the `Trace` shape from `@app/contracts`** (ADR-0007 amendment) — do not invent a parallel trace schema.
- Do NOT start #5 work (no Provider implementations) — separate ticket.
- Minimal changes; follow the repo's existing code style (template conventions: ≤300-line files, Valibot contracts, Logger adapter). Technical docs and code in English.

## Working agreements (user's rules — non-negotiable)

- **No `git commit`, push, or PR without explicit approval — ask each time.**
- PR title and description in English. Update PR title/body via `gh api --input` with a JSON payload file — never `gh pr edit --field body=...`.
- Do not close or modify spec issues (#1, #27). Tick #4's acceptance-criteria checkboxes as they complete (via `gh api --input` PATCH of the issue body — the plain `gh issue view` form errors on this repo; use `--json`).
- If anything in the ticket is ambiguous, ask the user before building.
- Staging deploys on push to `main` — keep the Staging workflow green; do not break it.

## Suggested approach (not prescriptive)

1. Define the `RagStore` interface in `packages/infra` first (the seam), then implement it against Neon — pluggability before implementation.
2. Write the migration(s) with a clean rollback; run them locally against your Neon dev/staging branch first.
3. RagStore contract tests against real Neon staging: vector insert + similarity round-trip on **both** `embedding_ar` and `embedding_id` (the AC calls this out explicitly — the dual-index choice stays reversible).
4. Probe `pg_search`/BM25 on the Neon plan; record the result (fallback tsvector) — this is an AC.
5. Storage/cost calc for dual 1536-dim vectors across the full v1 corpus (6,236 ayah + 650K hadith + ~10 kitab) — an AC; record it in the PR or an ADR if surprising.
6. `createSession`/`resolveUserId`/`deleteUserCascade` on RagStore; do NOT re-mount the routes (that's #10's wiring) — just the adapter methods + tables.

## Done means

- All of #4's ACs verifiably true: migrations apply + roll back clean from CLI, RagStore contract tests pass against real Neon staging, R2 readable/writable from the ingestion CLI env, `pg_search` probed and recorded, dual-vector storage/cost calc done and recorded, all Neon access behind the RagStore seam, `users`/`sessions` tables + session methods in place.
- `bun run check && bun run test && bun run boundary && bun run build` green locally; Staging workflow green on push.
- Final report to the user: which ACs are checked off, what #5 (Provider interface) will need next, and any Neon plan/cost findings.